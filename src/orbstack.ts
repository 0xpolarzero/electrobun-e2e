import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { dirname } from "node:path";
import type { ResolvedElectrobunE2EConfig } from "./config";
import { resolveSiblingLinuxPath } from "./config";

const BASE_APT_PACKAGES = [
  "bash",
  "build-essential",
  "ca-certificates",
  "cmake",
  "curl",
  "dbus-x11",
  "git",
  "libayatana-appindicator3-dev",
  "libgtk-3-dev",
  "librsvg2-dev",
  "libwebkit2gtk-4.1-dev",
  "pkg-config",
  "ripgrep",
  "rsync",
  "unzip",
  "xauth",
  "xvfb",
];

const DEFAULT_RUNTIME_ENV = {
  CI: "1",
  GDK_BACKEND: "x11",
  GSK_RENDERER: "cairo",
  LIBGL_ALWAYS_SOFTWARE: "1",
  WEBKIT_DISABLE_COMPOSITING_MODE: "1",
  WEBKIT_DISABLE_DMABUF_RENDERER: "1",
};

const DEFAULT_RETRY_ENV = {
  ELECTROBUN_E2E_LAUNCH_RETRIES: "2",
  ELECTROBUN_E2E_LAUNCH_RETRY_DELAY_MS: "750",
};

export async function setupOrbStackMachine(
  config: ResolvedElectrobunE2EConfig,
): Promise<void> {
  assertOrbReady();

  if (!machineExists(config.machineName)) {
    runHostCommand([
      "orb",
      "create",
      "-a",
      resolveMachineArch(),
      config.machineImage,
      config.machineName,
    ]);
  }

  const aptPackages = [...new Set([...BASE_APT_PACKAGES, ...config.extraAptPackages])];
  const remoteScript = `
set -euo pipefail

bun_version=${shellQuote(config.bunVersion)}
apt_packages=(${toShellArray(aptPackages)})

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "\${apt_packages[@]}"

export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "$bun_version" ]]; then
  rm -rf "$HOME/.bun"
  curl -fsSL https://bun.sh/install | bash -s -- "bun-v\${bun_version}"
fi

mkdir -p "$HOME/code"
`;

  await runRemoteScript(config.machineName, remoteScript);
}

export async function runOrbStackTests(
  config: ResolvedElectrobunE2EConfig,
  forwardedArgs: string[],
): Promise<void> {
  assertOrbReady();

  if (!machineExists(config.machineName)) {
    throw new Error(
      `OrbStack machine "${config.machineName}" is not set up. Run "bun run setup:e2e" first.`,
    );
  }

  const sharedLinuxPath = resolveSiblingLinuxPath(
    dirname(config.linuxWorkspaceDir),
    config.packageRootDir,
  );
  const syncPairs = [
    {
      hostPath: `/mnt/mac${config.consumerRootDir}`,
      linuxPath: config.linuxWorkspaceDir,
    },
    {
      hostPath: `/mnt/mac${config.packageRootDir}`,
      linuxPath: sharedLinuxPath,
    },
    ...config.localDependencyPaths.map((hostPath) => ({
      hostPath: `/mnt/mac${hostPath}`,
      linuxPath: resolveSiblingLinuxPath(dirname(config.linuxWorkspaceDir), hostPath),
    })),
  ];
  const requestedShardCount = process.env.ELECTROBUN_E2E_SHARDS?.trim() || "1";

  const remoteScript = `
set -euo pipefail

expand_path() {
  local raw_path="$1"
  case "$raw_path" in
    '$HOME'/*)
      printf '%s\\n' "$HOME/\${raw_path#\\$HOME/}"
      ;;
    '~'/*)
      printf '%s\\n' "$HOME/\${raw_path#~/}"
      ;;
    *)
      printf '%s\\n' "$raw_path"
      ;;
  esac
}

export PATH="$HOME/.bun/bin:$PATH"

for required in bun dbus-run-session rsync rg xvfb-run; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "Missing '$required' on the OrbStack machine. Run 'bun run setup:e2e' again." >&2
    exit 1
  fi
done

sync_host_paths=(${toShellArray(syncPairs.map((pair) => pair.hostPath))})
sync_linux_paths=(${toShellArray(syncPairs.map((pair) => pair.linuxPath))})
sync_excludes=(${toShellArray(config.syncExcludes)})
dependency_linux_paths=(${toShellArray([
    sharedLinuxPath,
    ...config.localDependencyPaths.map((hostPath) =>
      resolveSiblingLinuxPath(dirname(config.linuxWorkspaceDir), hostPath),
    ),
  ])})

exclude_args=()
for entry in "\${sync_excludes[@]}"; do
  exclude_args+=("--exclude" "$entry")
done

for index in "\${!sync_host_paths[@]}"; do
  linux_path="$(expand_path "\${sync_linux_paths[$index]}")"
  mkdir -p "$(dirname "$linux_path")"
  rsync -a --delete "\${exclude_args[@]}" "\${sync_host_paths[$index]}/" "$linux_path/"
done

install_bun_package_if_present() {
  local package_dir="$1"
  if [[ ! -f "$package_dir/package.json" ]]; then
    return
  fi

  if [[ -f "$package_dir/bun.lock" ]]; then
    (cd "$package_dir" && bun install --frozen-lockfile)
    return
  fi

  (cd "$package_dir" && bun install)
}

for raw_dependency_path in "\${dependency_linux_paths[@]}"; do
  install_bun_package_if_present "$(expand_path "$raw_dependency_path")"
done

workspace_dir="$(expand_path ${shellQuote(config.linuxWorkspaceDir)})"
cd "$workspace_dir"
rm -rf build dist

install_cmd=(${toShellArray(config.installCommand)})
build_cmd=(${toShellArray(config.buildCommand)})

"\${install_cmd[@]}"
"\${build_cmd[@]}"

export ${toShellExports({
    ...DEFAULT_RUNTIME_ENV,
    ...DEFAULT_RETRY_ENV,
    ...config.runtimeEnv,
  })}

run_headless_test_cmd() {
  dbus-run-session -- xvfb-run -a -s "-screen 0 1440x900x24 +extension GLX +render -noreset" "$@"
}

run_sharded_bun_tests() {
  local requested_shards="$1"
  shift
  local files=("$@")
  local total_files="\${#files[@]}"
  local shard_stagger_seconds="2"

  if [[ "$requested_shards" -lt 2 ]] || [[ "$total_files" -lt 2 ]]; then
    run_headless_test_cmd bun test --max-concurrency=1 "\${files[@]}"
    return
  fi

  local shard_count="$requested_shards"
  if [[ "$shard_count" -gt "$total_files" ]]; then
    shard_count="$total_files"
  fi

  echo "Starting $shard_count e2e shard(s) on OrbStack..."

  local shard_dir
  shard_dir="$(mktemp -d)"
  local -a shard_lists=()
  local -a shard_pids=()

  cleanup_shard_processes() {
    for shard_pid in "\${shard_pids[@]}"; do
      if kill -0 "$shard_pid" >/dev/null 2>&1; then
        kill "$shard_pid" >/dev/null 2>&1 || true
      fi
    done
  }

  trap cleanup_shard_processes INT TERM

  for ((shard_index = 0; shard_index < shard_count; shard_index += 1)); do
    shard_lists+=("$shard_dir/shard-$shard_index.txt")
    : > "$shard_dir/shard-$shard_index.txt"
  done

  for ((file_index = 0; file_index < total_files; file_index += 1)); do
    local target_index=$((file_index % shard_count))
    printf '%s\n' "\${files[$file_index]}" >> "\${shard_lists[$target_index]}"
  done

  for ((shard_index = 0; shard_index < shard_count; shard_index += 1)); do
    local shard_list="\${shard_lists[$shard_index]}"
    if [[ ! -s "$shard_list" ]]; then
      continue
    fi

    local shard_log="$shard_dir/shard-$shard_index.log"

    (
      mapfile -t shard_files < "$shard_list"
      {
        echo "== e2e shard $((shard_index + 1))/$shard_count =="
        printf 'files: %s\n' "\${shard_files[*]}"
        run_headless_test_cmd bun test --max-concurrency=1 "\${shard_files[@]}"
      } 2>&1 | tee "$shard_log"
    ) &

    shard_pids+=("$!")

    if [[ "$shard_index" -lt $((shard_count - 1)) ]]; then
      sleep "$shard_stagger_seconds"
    fi
  done

  local shard_failed=0
  for shard_pid in "\${shard_pids[@]}"; do
    if ! wait "$shard_pid"; then
      shard_failed=1
    fi
  done

  trap - INT TERM
  rm -rf "$shard_dir"

  if [[ "$shard_failed" -ne 0 ]]; then
    exit 1
  fi
}

forwarded_args=(${toShellArray(forwardedArgs)})
normalized_forwarded_args=()
requested_shards_raw=${shellQuote(requestedShardCount)}
requested_shards=1

for raw_arg in "\${forwarded_args[@]}"; do
  if [[ "$raw_arg" != -* ]] && [[ "$raw_arg" != ./* ]] && [[ "$raw_arg" != /* ]] && [[ -e "$raw_arg" ]]; then
    normalized_forwarded_args+=("./$raw_arg")
  else
    normalized_forwarded_args+=("$raw_arg")
  fi
done

if [[ "$requested_shards_raw" =~ ^[1-9][0-9]*$ ]]; then
  requested_shards="$requested_shards_raw"
fi

if [[ "\${#normalized_forwarded_args[@]}" -gt 0 ]]; then
  if [[ ${config.testCommand ? "1" : "0"} -eq 1 ]]; then
    test_cmd=(${toShellArray(config.testCommand ?? [])} "\${normalized_forwarded_args[@]}")
  else
    test_files=("\${normalized_forwarded_args[@]}")
  fi
else
  ${
    config.testCommand
      ? `test_cmd=(${toShellArray(config.testCommand)})`
      : `
mapfile -t discovered_test_files < <(
  rg --files e2e ${config.testFileGlobs.map((pattern) => `-g ${shellQuote(pattern)}`).join(" ")} |
    sed 's#^#./#'
)
test_files=("\${discovered_test_files[@]}")
`
  }
fi

if [[ ${config.testCommand ? "1" : "0"} -eq 1 ]]; then
  run_headless_test_cmd "\${test_cmd[@]}"
elif [[ "$requested_shards" -gt 1 ]]; then
  shardable=1
  for raw_arg in "\${normalized_forwarded_args[@]}"; do
    if [[ "$raw_arg" == -* ]]; then
      shardable=0
      break
    fi
  done

  if [[ "$shardable" -eq 1 ]]; then
    run_sharded_bun_tests "$requested_shards" "\${test_files[@]}"
  else
    run_headless_test_cmd bun test --max-concurrency=1 "\${test_files[@]}"
  fi
else
  run_headless_test_cmd bun test --max-concurrency=1 "\${test_files[@]}"
fi
`;

  await runRemoteScript(config.machineName, remoteScript);
}

function assertOrbReady(): void {
  if (!commandExists("orb")) {
    throw new Error(`OrbStack CLI ("orb") is not installed or not on PATH.`);
  }

  const status = spawnSync("orb", ["status"], {
    stdio: "ignore",
  });
  if (status.status !== 0) {
    throw new Error("OrbStack is not running.");
  }
}

function commandExists(name: string): boolean {
  const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(name)} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function machineExists(machineName: string): boolean {
  const result = spawnSync("orb", ["info", machineName], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function resolveMachineArch(hostArch: string = process.arch): "amd64" | "arm64" {
  switch (hostArch) {
    case "arm64":
    case "aarch64":
      return "arm64";
    case "x64":
    case "x86_64":
    case "amd64":
      return "amd64";
    default:
      throw new Error(`Unsupported host architecture for OrbStack machine setup: ${hostArch}`);
  }
}

function runHostCommand(command: string[]): void {
  const result = spawnSync(command[0] as string, command.slice(1), {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? "null"}): ${command.join(" ")}`);
  }
}

async function runRemoteScript(machineName: string, script: string): Promise<void> {
  const proc = spawn("orb", ["-m", machineName, "bash", "-s"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  proc.stdin.end(script);

  let interrupted = false;
  const forwardSigint = () => {
    interrupted = true;
    process.stderr.write("\nInterrupted, stopping OrbStack e2e run...\n");
    proc.kill("SIGINT");
    setTimeout(() => proc.kill("SIGTERM"), 1_000).unref();
    setTimeout(() => proc.kill("SIGKILL"), 4_000).unref();
  };
  const forwardSigterm = () => {
    interrupted = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 3_000).unref();
  };

  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);

  try {
    const [exitCode, signal] = (await once(proc, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];

    if (interrupted) {
      process.exitCode = 130;
      return;
    }

    if (signal) {
      throw new Error(`Remote OrbStack command exited from signal ${signal}.`);
    }

    if (exitCode !== 0) {
      throw new Error(`Remote OrbStack command failed on "${machineName}" (${exitCode}).`);
    }
  } finally {
    process.removeListener("SIGINT", forwardSigint);
    process.removeListener("SIGTERM", forwardSigterm);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toShellArray(values: string[]): string {
  return values.map((value) => shellQuote(value)).join(" ");
}

function toShellExports(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}
