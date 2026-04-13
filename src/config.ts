import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_MACHINE_IMAGE = "ubuntu:24.04";
const DEFAULT_SYNC_EXCLUDES = ["build", "dist", "node_modules"];
const DEFAULT_TEST_FILE_GLOBS = ["*.test.ts", "*.spec.ts", "*_test.ts", "*_spec.ts"];

export interface ElectrobunE2EConfig {
  appName: string;
  buildCommand?: string[];
  extraAptPackages?: string[];
  installCommand?: string[];
  linuxWorkspaceDir?: string;
  localDependencyPaths?: string[];
  machineImage?: string;
  machineName?: string;
  runtimeEnv?: Record<string, string>;
  syncExcludes?: string[];
  testCommand?: string[];
  testFileGlobs?: string[];
}

export interface ResolvedElectrobunE2EConfig {
  appName: string;
  buildCommand: string[];
  bunVersion: string;
  configPath: string;
  consumerRootDir: string;
  extraAptPackages: string[];
  installCommand: string[];
  linuxWorkspaceDir: string;
  localDependencyPaths: string[];
  machineImage: string;
  machineName: string;
  packageRootDir: string;
  runtimeEnv: Record<string, string>;
  syncExcludes: string[];
  testCommand: string[] | null;
  testFileGlobs: string[];
}

export function defineElectrobunE2EConfig(config: ElectrobunE2EConfig): ElectrobunE2EConfig {
  return config;
}

export async function loadElectrobunE2EConfig(
  configPath: string,
  packageRootDir: string,
): Promise<ResolvedElectrobunE2EConfig> {
  const resolvedConfigPath = resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`Config file not found: ${resolvedConfigPath}`);
  }

  const module = (await import(pathToFileURL(resolvedConfigPath).href)) as {
    config?: ElectrobunE2EConfig;
    default?: ElectrobunE2EConfig;
  };
  const config = module.default ?? module.config;
  if (!config) {
    throw new Error(
      `Config file must export a default Electrobun e2e config: ${resolvedConfigPath}`,
    );
  }

  if (!config.appName.trim()) {
    throw new Error(`Config appName must be non-empty: ${resolvedConfigPath}`);
  }

  const consumerRootDir = dirname(resolvedConfigPath);
  const slug = slugify(config.appName);
  const machineName =
    process.env.ELECTROBUN_E2E_ORB_MACHINE?.trim() ||
    config.machineName?.trim() ||
    `${slug}-e2e`;
  const linuxWorkspaceDir =
    process.env.ELECTROBUN_E2E_ORB_WORKSPACE?.trim() ||
    config.linuxWorkspaceDir?.trim() ||
    `$HOME/code/${slug}`;

  return {
    appName: config.appName,
    buildCommand: config.buildCommand ?? ["bun", "run", "build"],
    bunVersion: readBunVersion(join(consumerRootDir, "package.json")),
    configPath: resolvedConfigPath,
    consumerRootDir: realpathSync(consumerRootDir),
    extraAptPackages: dedupe(config.extraAptPackages ?? []),
    installCommand: config.installCommand ?? ["bun", "install", "--frozen-lockfile"],
    linuxWorkspaceDir,
    localDependencyPaths: dedupe(
      (config.localDependencyPaths ?? []).map((value) => realpathSync(resolve(consumerRootDir, value))),
    ),
    machineImage: config.machineImage?.trim() || DEFAULT_MACHINE_IMAGE,
    machineName,
    packageRootDir: realpathSync(packageRootDir),
    runtimeEnv: { ...(config.runtimeEnv ?? {}) },
    syncExcludes: dedupe([...DEFAULT_SYNC_EXCLUDES, ...(config.syncExcludes ?? [])]),
    testCommand: config.testCommand ? [...config.testCommand] : null,
    testFileGlobs: dedupe(config.testFileGlobs ?? DEFAULT_TEST_FILE_GLOBS),
  };
}

export function resolveDefaultConfigPath(cwd = process.cwd()): string {
  return join(cwd, "electrobun-e2e.config.ts");
}

export function resolvePackageRootDir(fromFile = import.meta.url): string {
  const filePath = fileURLToPath(fromFile);
  return realpathSync(resolve(dirname(filePath), ".."));
}

export function resolveSiblingLinuxPath(parentPath: string, hostPath: string): string {
  return join(parentPath, basename(hostPath));
}

function readBunVersion(packageJsonPath: string): string {
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Could not find package.json for Bun version lookup: ${packageJsonPath}`);
  }

  const content = readFileSync(packageJsonPath, "utf8");
  const match = content.match(/"packageManager"\s*:\s*"bun@([^"]+)"/);
  if (!match?.[1]) {
    throw new Error(`Could not determine Bun version from ${packageJsonPath}.`);
  }

  return match[1];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
