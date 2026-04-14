import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Driver, Page } from "electrobun-browser-tools";
import {
  connectToElectrobunBridge,
  type BridgeMetadataStrategy,
  waitForBridgeMetadata,
} from "./bridge";
import {
  resolveElectrobunBuildTargetDir,
  resolveElectrobunLauncherPath,
  resolveElectrobunWorkspaceDir,
} from "./electrobun-paths";
import { withTransientLinuxLaunchRetries } from "./linux-launch-retry";
import {
  buildTrackedPidList,
  formatSpawnFailure,
  runCommand,
  terminateTrackedProcesses,
} from "./process";
import {
  createIsolatedHomeDir,
  createIsolatedRuntimeEnv,
  ensureIsolatedHomeDirLayout,
} from "./temp-home";

const DEFAULT_DRIVER_CONNECT_TIMEOUT_MS = 20_000;
const buildPromises = new Map<string, Promise<void>>();

export interface LaunchedElectrobunApp {
  appId: string;
  bridgeUrl: string | null;
  driver: Driver;
  page: Page;
  homeDir: string;
  workspaceDir: string;
  stdout: string[];
  stderr: string[];
  close: () => Promise<void>;
}

export interface LaunchElectrobunAppOptions {
  beforeLaunch?: (context: {
    homeDir: string;
    runtimeEnv: NodeJS.ProcessEnv;
    workspaceDir: string;
  }) => Promise<void> | void;
  bridgeMetadata: BridgeMetadataStrategy;
  buildCommand?: string[];
  driverConnectTimeoutMs?: number;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  launcherPath?: string;
  projectRoot: string;
  ready: (context: {
    appId: string;
    bridgeUrl: string | null;
    driver: Driver;
    page: Page;
  }) => Promise<void>;
  retryLabel?: string;
  workspaceDir?: string;
}

export async function ensureElectrobunBuilt(options: {
  buildCommand?: string[];
  projectRoot: string;
}): Promise<void> {
  const buildTargetDir = resolveElectrobunBuildTargetDir(options.projectRoot);
  if (existsSync(buildTargetDir)) {
    return;
  }

  const cacheKey = options.projectRoot;
  const existing = buildPromises.get(cacheKey);
  if (existing) {
    return await existing;
  }

  const buildCommand = options.buildCommand ?? [process.execPath, "run", "build"];
  const buildPromise = runCommand(buildCommand, options.projectRoot).finally(() => {
    buildPromises.delete(cacheKey);
  });
  buildPromises.set(cacheKey, buildPromise);
  return await buildPromise;
}

export async function withElectrobunApp<T>(
  options: LaunchElectrobunAppOptions,
  fn: (app: LaunchedElectrobunApp) => Promise<T>,
): Promise<T> {
  const app = await launchElectrobunApp(options);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

export async function launchElectrobunApp(
  options: LaunchElectrobunAppOptions,
): Promise<LaunchedElectrobunApp> {
  await ensureElectrobunBuilt({
    projectRoot: options.projectRoot,
    ...(options.buildCommand ? { buildCommand: options.buildCommand } : {}),
  });

  const workspaceDir =
    options.workspaceDir ?? resolveElectrobunWorkspaceDir(options.projectRoot);
  const providedHomeDir = options.homeDir;

  return await withTransientLinuxLaunchRetries(
    options.retryLabel ?? "launchElectrobunApp",
    async () => {
      const ownsHomeDir = !providedHomeDir;
      const homeDir = providedHomeDir ?? (await createIsolatedHomeDir());
      const runtimeEnv = createIsolatedRuntimeEnv(homeDir, options.env);

      try {
        await ensureIsolatedHomeDirLayout(homeDir);
        await options.beforeLaunch?.({
          homeDir,
          runtimeEnv,
          workspaceDir,
        });

        return await launchElectrobunAppOnce({
          bridgeMetadata: options.bridgeMetadata,
          driverConnectTimeoutMs:
            options.driverConnectTimeoutMs ?? DEFAULT_DRIVER_CONNECT_TIMEOUT_MS,
          homeDir,
          launcherPath:
            options.launcherPath ?? resolveElectrobunLauncherPath(options.projectRoot),
          ownsHomeDir,
          ready: options.ready,
          runtimeEnv,
          workspaceDir,
        });
      } catch (error) {
        if (ownsHomeDir) {
          await rm(homeDir, { force: true, recursive: true });
        }
        throw error;
      }
    },
  );
}

async function launchElectrobunAppOnce(options: {
  bridgeMetadata: BridgeMetadataStrategy;
  driverConnectTimeoutMs: number;
  homeDir: string;
  launcherPath: string;
  ownsHomeDir: boolean;
  ready: LaunchElectrobunAppOptions["ready"];
  runtimeEnv: NodeJS.ProcessEnv;
  workspaceDir: string;
}): Promise<LaunchedElectrobunApp> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let driver: Driver | null = null;
  let appPid: number | null = null;

  await ensureIsolatedHomeDirLayout(options.homeDir);

  try {
    const launchedProc = Bun.spawn([options.launcherPath], {
      cwd: dirname(options.launcherPath),
      env: options.runtimeEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = launchedProc;

    const metadata = await waitForBridgeMetadata(
      launchedProc,
      stdout,
      stderr,
      options.bridgeMetadata,
    );
    const connected = await connectToElectrobunBridge(
      metadata,
      options.driverConnectTimeoutMs,
    );
    driver = connected.driver;
    appPid = await resolveAppPid(driver);
    await options.ready({
      appId: connected.appId,
      bridgeUrl: connected.bridgeUrl,
      driver,
      page: connected.page,
    });

    return {
      appId: connected.appId,
      bridgeUrl: connected.bridgeUrl,
      driver: connected.driver,
      page: connected.page,
      homeDir: options.homeDir,
      workspaceDir: options.workspaceDir,
      stdout,
      stderr,
      close: async () => {
        await closeElectrobunApp(connected.driver, launchedProc, appPid);
        if (options.ownsHomeDir) {
          await rm(options.homeDir, { force: true, recursive: true });
        }
      },
    };
  } catch (error) {
    if (driver && proc) {
      const connectedDriver = driver;
      try {
        await closeElectrobunApp(connectedDriver, proc, appPid);
      } catch {
        // Ignore cleanup failures while unwinding a failed launch.
      }
    } else if (proc) {
      await terminateTrackedProcesses(buildTrackedPidList(proc.pid), proc);
    }

    throw new Error(
      formatSpawnFailure(
        error instanceof Error ? error.message : String(error),
        proc,
        stdout,
        stderr,
      ),
      { cause: error },
    );
  }
}

export async function closeElectrobunApp(
  driver: Driver,
  proc: ReturnType<typeof Bun.spawn>,
  appPid: number | null,
): Promise<void> {
  try {
    await driver.close();
  } catch {
    // Ignore bridge teardown errors during shutdown.
  }

  await terminateTrackedProcesses(buildTrackedPidList(proc.pid, appPid), proc);
}

async function resolveAppPid(driver: Driver): Promise<number | null> {
  try {
    const doctor = await driver.doctor();
    const pid = doctor?.app?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
