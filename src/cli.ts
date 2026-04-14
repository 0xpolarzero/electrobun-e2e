#!/usr/bin/env bun

import {
  loadElectrobunE2EConfig,
  resolveDefaultConfigPath,
  resolvePackageRootDir,
} from "./config";
import { runOrbStackTests, setupOrbStackMachine } from "./orbstack";

type CliCommand = "run" | "setup";

async function main(): Promise<void> {
  const { command, configPath, forwardedArgs } = parseArgs(process.argv.slice(2));
  const packageRootDir = resolvePackageRootDir();
  const config = await loadElectrobunE2EConfig(configPath, packageRootDir);

  switch (command) {
    case "setup":
      await setupOrbStackMachine(config);
      return;
    case "run":
      await runOrbStackTests(config, forwardedArgs);
      return;
    default:
      throw new Error(`Unsupported command: ${String(command)}`);
  }
}

function parseArgs(argv: string[]): {
  command: CliCommand;
  configPath: string;
  forwardedArgs: string[];
} {
  const [commandRaw, ...rest] = argv;
  if (commandRaw !== "setup" && commandRaw !== "run") {
    printUsageAndExit();
  }

  let configPath = resolveDefaultConfigPath();
  const forwardedArgs: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index] as string;
    if (value === "--") {
      forwardedArgs.push(...rest.slice(index + 1));
      break;
    }

    if (value === "--config") {
      const next = rest[index + 1];
      if (!next) {
        throw new Error("--config requires a path.");
      }
      configPath = next;
      index += 1;
      continue;
    }

    if (commandRaw === "run") {
      forwardedArgs.push(...rest.slice(index));
      break;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return {
    command: commandRaw,
    configPath,
    forwardedArgs,
  };
}

function printUsageAndExit(): never {
  console.error(
    [
      "Usage:",
      "  electrobun-e2e setup [--config ./electrobun-e2e.config.ts]",
      "  electrobun-e2e run [--config ./electrobun-e2e.config.ts] [-- <bun test args>]",
    ].join("\n"),
  );
  process.exit(1);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
