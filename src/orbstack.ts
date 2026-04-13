import { spawnSync } from "node:child_process";
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

export function setupOrbStackMachine(config: ResolvedElectrobunE2EConfig): void {
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

  runRemoteScript(config.machineName, remoteScript);
}

export function runOrbStackTests(
  config: ResolvedElectrobunE2EConfig,
  forwardedArgs: string[],
): void {
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

forwarded_args=(${toShellArray(forwardedArgs)})
normalized_forwarded_args=()

for raw_arg in "\${forwarded_args[@]}"; do
  if [[ "$raw_arg" != -* ]] && [[ "$raw_arg" != ./* ]] && [[ "$raw_arg" != /* ]] && [[ -e "$raw_arg" ]]; then
    normalized_forwarded_args+=("./$raw_arg")
  else
    normalized_forwarded_args+=("$raw_arg")
  fi
done

if [[ "\${#normalized_forwarded_args[@]}" -gt 0 ]]; then
  if [[ ${config.testCommand ? "1" : "0"} -eq 1 ]]; then
    test_cmd=(${toShellArray(config.testCommand ?? [])} "\${normalized_forwarded_args[@]}")
  else
    test_cmd=(bun test --max-concurrency=1 "\${normalized_forwarded_args[@]}")
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
test_cmd=(bun test --max-concurrency=1 "\${discovered_test_files[@]}")
`
  }
fi

dbus-run-session -- xvfb-run -a -s "-screen 0 1440x900x24" "\${test_cmd[@]}"
`;

  runRemoteScript(config.machineName, remoteScript);
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

function runRemoteScript(machineName: string, script: string): void {
  const result = spawnSync("orb", ["-m", machineName, "bash", "-s"], {
    input: script,
    stdio: ["pipe", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    throw new Error(
      `Remote OrbStack command failed on "${machineName}" (${result.status ?? "null"}).`,
    );
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
