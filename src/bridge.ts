import { connect, type Driver, type Page } from "electrobun-browser-tools";
import { formatSpawnFailure, pumpLines } from "./process";

const DEFAULT_BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS = 2_000;
const DEFAULT_BRIDGE_CONNECT_POLL_INTERVAL_MS = 100;

export interface BridgeMetadata {
  appId: string;
  bridgeUrl: string | null;
}

export interface BridgeMetadataStrategy {
  metadataLabel?: string;
  parseLine: (line: string) => BridgeMetadata | null;
  processLabel?: string;
  startupTimeoutMs?: number;
}

export interface ConnectedElectrobunBridge {
  appId: string;
  bridgeUrl: string | null;
  driver: Driver;
  page: Page;
}

export function createJsonBridgeMetadataParser(prefix: string) {
  const pattern = new RegExp(`^${escapeForRegExp(prefix)}\\s*(\\{.*\\})$`);

  return (line: string): BridgeMetadata | null => {
    const match = line.match(pattern);
    if (!match) {
      return null;
    }

    const parsed = JSON.parse(match[1] as string) as {
      appId?: string;
      bridgeUrl?: string | null;
    };

    if (!parsed.appId) {
      throw new Error(`Bridge metadata did not include an appId for prefix "${prefix}".`);
    }

    return {
      appId: parsed.appId,
      bridgeUrl: parsed.bridgeUrl ?? null,
    };
  };
}

export async function waitForBridgeMetadata(
  proc: ReturnType<typeof Bun.spawn>,
  stdout: string[],
  stderr: string[],
  strategy: BridgeMetadataStrategy,
): Promise<BridgeMetadata> {
  let settled = false;
  const metadataLabel = strategy.metadataLabel ?? "bridge metadata";
  const processLabel = strategy.processLabel ?? "app";
  const startupTimeoutMs = strategy.startupTimeoutMs ?? 30_000;

  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(
        new Error(
          formatSpawnFailure(
            `Timed out waiting for ${metadataLabel}.`,
            proc,
            stdout,
            stderr,
          ),
        ),
      );
    }, startupTimeoutMs);

    const finish = (value: BridgeMetadata) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };

    const fail = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      reject(new Error(formatSpawnFailure(message, proc, stdout, stderr)));
    };

    void pumpLines(proc.stdout, (line) => {
      stdout.push(line);

      try {
        const metadata = strategy.parseLine(line);
        if (metadata) {
          finish(metadata);
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }).catch((error) => fail(error instanceof Error ? error.message : String(error)));

    void pumpLines(proc.stderr, (line) => {
      stderr.push(line);
    }).catch(() => {});

    void proc.exited.then((exitCode) => {
      if (settled) {
        return;
      }
      fail(`${processLabel} exited before the bridge became available (exit code ${exitCode}).`);
    });
  });
}

export async function connectToElectrobunBridge(
  metadata: BridgeMetadata,
  timeoutMs = 20_000,
): Promise<ConnectedElectrobunBridge> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const attemptTimeoutMs = Math.max(
      1,
      Math.min(DEFAULT_BRIDGE_CONNECT_ATTEMPT_TIMEOUT_MS, remainingMs),
    );

    try {
      const driver = await connect({
        ...(metadata.bridgeUrl ? { url: metadata.bridgeUrl } : { app: metadata.appId }),
        timeout: attemptTimeoutMs,
      });

      return {
        appId: metadata.appId,
        bridgeUrl: metadata.bridgeUrl,
        driver,
        page: driver.page("active"),
      };
    } catch (error) {
      lastError = error;
      const sleepMs = Math.min(
        DEFAULT_BRIDGE_CONNECT_POLL_INTERVAL_MS,
        Math.max(0, deadline - Date.now()),
      );
      if (sleepMs > 0) {
        await Bun.sleep(sleepMs);
      }
    }
  }

  const reason =
    lastError instanceof Error
      ? lastError.message
      : lastError
        ? String(lastError)
        : "Bridge never accepted a connection.";
  throw new Error(
    `Timed out connecting to Electrobun bridge (${metadata.bridgeUrl ?? metadata.appId}): ${reason}`,
  );
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
