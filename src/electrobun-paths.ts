import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export type ElectrobunPlatform = "darwin" | "linux" | "win32";

function normalizePlatform(platform: NodeJS.Platform): ElectrobunPlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }

  throw new Error(`Unsupported Electrobun platform: ${platform}`);
}

function resolveBuildTargetName(platform: ElectrobunPlatform, arch: string): string {
  const platformName = platform === "darwin" ? "macos" : platform;
  return `dev-${platformName}-${arch}`;
}

export function resolveElectrobunPlatform(platform = process.platform): ElectrobunPlatform {
  return normalizePlatform(platform);
}

export function resolveElectrobunBuildTargetDir(
  rootDir: string,
  platform = process.platform,
  arch = process.arch,
): string {
  return join(rootDir, "build", resolveBuildTargetName(resolveElectrobunPlatform(platform), arch));
}

export function resolveElectrobunLauncherPath(
  rootDir: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const buildTargetDir = resolveElectrobunBuildTargetDir(rootDir, platform, arch);
  const launcherName = resolveElectrobunPlatform(platform) === "win32" ? "launcher.exe" : "launcher";

  if (!existsSync(buildTargetDir)) {
    throw new Error(`Electrobun build directory does not exist: ${buildTargetDir}`);
  }

  const pending = [buildTargetDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }

    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const candidate = join(currentDir, entry.name);
      if (entry.isFile() && entry.name === launcherName) {
        return candidate;
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
      }
    }
  }

  throw new Error(`Could not find ${launcherName} under ${buildTargetDir}.`);
}

export function resolveElectrobunExecutableDir(
  rootDir: string,
  platform = process.platform,
  arch = process.arch,
): string {
  return dirname(resolveElectrobunLauncherPath(rootDir, platform, arch));
}

export function resolveElectrobunWorkspaceDir(
  rootDir: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const buildDir = join(rootDir, "build");
  if (!existsSync(buildDir)) {
    return realpathSync(rootDir);
  }

  return resolveElectrobunExecutableDir(rootDir, platform, arch);
}

export function resolveElectrobunAppCodeDir(
  buildDir: string,
  appName: string,
  platform = process.platform,
): string {
  const normalizedPlatform = resolveElectrobunPlatform(platform);
  const macAppCodeDir = join(buildDir, `${appName}.app`, "Contents", "Resources", "app");
  if (normalizedPlatform === "darwin" || existsSync(macAppCodeDir)) {
    return macAppCodeDir;
  }

  return join(buildDir, appName, "Resources", "app");
}
