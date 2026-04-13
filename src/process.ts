import { spawnSync } from "node:child_process";

export async function runCommand(
  command: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      CI: "1",
      ...envOverrides,
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

export async function pumpLines(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream || typeof stream === "number") {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        if (line) {
          onLine(line);
        }
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    const trailing = buffer.replace(/\r$/, "").trimEnd();
    if (trailing) {
      onLine(trailing);
    }
    reader.releaseLock();
  }
}

export function formatSpawnFailure(
  message: string,
  proc: ReturnType<typeof Bun.spawn> | null,
  stdout: string[],
  stderr: string[],
): string {
  const lines = [
    message,
    `exitCode=${proc?.exitCode ?? "null"}`,
    stdout.length > 0 ? `stdout:\n${stdout.join("\n")}` : "stdout: <empty>",
    stderr.length > 0 ? `stderr:\n${stderr.join("\n")}` : "stderr: <empty>",
  ];
  return lines.join("\n");
}

function listDescendantPids(rootPid: number): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return [];
  }

  const pending = [rootPid];
  const seen = new Set<number>();
  const descendants: number[] = [];

  while (pending.length > 0) {
    const currentPid = pending.pop();
    if (!currentPid || seen.has(currentPid)) {
      continue;
    }
    seen.add(currentPid);

    let output = "";
    try {
      const result = spawnSync("pgrep", ["-P", String(currentPid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status !== 0) {
        continue;
      }
      output = result.stdout;
    } catch {
      continue;
    }

    for (const line of output.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) {
        continue;
      }
      descendants.push(pid);
      pending.push(pid);
    }
  }

  return descendants;
}

function signalPidList(pids: number[], signal: "SIGTERM" | "SIGKILL"): void {
  const command = signal === "SIGKILL" ? "-KILL" : "-TERM";

  for (const pid of pids) {
    try {
      spawnSync("kill", [command, String(pid)], {
        stdio: "ignore",
      });
    } catch {
      // Ignore already-exited descendants.
    }
  }
}

export function buildTrackedPidList(...rootPids: Array<number | null | undefined>): number[] {
  const tracked = new Set<number>();

  for (const candidate of rootPids) {
    if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 0) {
      continue;
    }

    const rootPid: number = candidate;
    tracked.add(rootPid);
    for (const descendantPid of listDescendantPids(rootPid)) {
      tracked.add(descendantPid);
    }
  }

  return [...tracked];
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    const result = spawnSync("kill", ["-0", String(pid)], {
      stdio: "ignore",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function waitForPidListExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (pids.every((pid) => !isPidAlive(pid))) {
      return true;
    }
    await Bun.sleep(100);
  }

  return pids.every((pid) => !isPidAlive(pid));
}

export async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      proc.exited,
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function terminateTrackedProcesses(
  trackedPids: number[],
  proc: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  if (trackedPids.length === 0) {
    return;
  }

  signalPidList(trackedPids, "SIGTERM");
  await Promise.all([waitForExit(proc, 2_000), waitForPidListExit(trackedPids, 3_000)]);

  if (trackedPids.every((pid) => !isPidAlive(pid))) {
    return;
  }

  signalPidList(trackedPids, "SIGKILL");
  await Promise.all([waitForExit(proc, 2_000), waitForPidListExit(trackedPids, 2_000)]);
}
