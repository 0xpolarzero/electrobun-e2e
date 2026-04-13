import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createIsolatedHomeDir(prefix = "electrobun-e2e-home-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

export async function ensureIsolatedHomeDirLayout(homeDir: string): Promise<void> {
  await Promise.all([
    mkdir(join(homeDir, ".config"), { recursive: true }),
    mkdir(join(homeDir, ".local"), { recursive: true }),
    mkdir(join(homeDir, ".cache"), { recursive: true }),
    mkdir(join(homeDir, ".state"), { recursive: true }),
    mkdir(join(homeDir, ".tmp"), { recursive: true }),
  ]);
}

export function createIsolatedRuntimeEnv(
  homeDir: string,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const xdgConfigHome = join(homeDir, ".config");
  const xdgDataHome = join(homeDir, ".local", "share");
  const xdgCacheHome = join(homeDir, ".cache");
  const xdgStateHome = join(homeDir, ".state");
  const tmpDir = join(homeDir, ".tmp");

  return {
    ...process.env,
    CI: "1",
    HOME: homeDir,
    TMPDIR: tmpDir,
    XDG_CACHE_HOME: xdgCacheHome,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
    ...overrides,
  };
}
