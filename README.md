# electrobun-e2e

`electrobun-e2e` is a small shared package for running Electrobun end-to-end suites headless on Linux inside an OrbStack machine.

It is intentionally narrow:

- one execution path only: synced from the current macOS checkout into an OrbStack Ubuntu machine
- one display mode only: headless under `dbus-run-session` plus `xvfb-run`
- reusable Electrobun launch/build/orchestration helpers with consumer-defined app readiness and fixtures

It does not provide:

- Docker support
- visible local desktop e2e runs
- a framework for app-specific selectors, fixtures, auth seeding, or product assertions

## Prerequisites

- macOS with OrbStack installed and running
- Bun installed on the host
- an Electrobun app repository
- the consumer repository depending on this package via a sibling `file:../electrobun-e2e` dependency

## Consumer Integration

1. Add the sibling dependency:

```json
{
  "devDependencies": {
    "electrobun-e2e": "file:../electrobun-e2e"
  }
}
```

2. Add an `electrobun-e2e.config.ts` file in the consumer repo:

```ts
import { defineElectrobunE2EConfig } from "electrobun-e2e/config";

export default defineElectrobunE2EConfig({
  appName: "my-app",
  runtimeEnv: {
    MY_APP_E2E_HEADLESS: "1",
  },
});
```

3. Point package scripts at the shared CLI:

```json
{
  "scripts": {
    "setup:e2e": "electrobun-e2e setup",
    "test:e2e": "electrobun-e2e run"
  }
}
```

4. Wrap the shared runtime launcher inside the consumer harness:

```ts
import {
  createJsonBridgeMetadataParser,
  ensureElectrobunBuilt,
  launchElectrobunApp,
  withElectrobunApp,
} from "electrobun-e2e";

const PROJECT_ROOT = process.cwd();

const bridgeMetadata = {
  metadataLabel: "my-app bridge metadata",
  parseLine: createJsonBridgeMetadataParser("my-app bridge:"),
  processLabel: "my-app",
};

export function ensureBuilt() {
  return ensureElectrobunBuilt({ projectRoot: PROJECT_ROOT });
}

export function launchMyApp() {
  return launchElectrobunApp({
    projectRoot: PROJECT_ROOT,
    bridgeMetadata,
    ready: async ({ page }) => {
      await page.getByRole("button", { name: "Open settings" }).waitFor({ state: "visible" });
    },
    env: {
      MY_APP_E2E_HEADLESS: "1",
    },
  });
}

export function withMyApp(fn: (app: Awaited<ReturnType<typeof launchMyApp>>) => Promise<void>) {
  return withElectrobunApp(
    {
      projectRoot: PROJECT_ROOT,
      bridgeMetadata,
      ready: async ({ page }) => {
        await page.getByRole("button", { name: "Open settings" }).waitFor({ state: "visible" });
      },
      env: {
        MY_APP_E2E_HEADLESS: "1",
      },
    },
    fn,
  );
}
```

The harness is where app-specific behavior belongs:

- bridge log prefix assumptions
- environment variable names
- workspace-ready selectors
- seeded fixture files and auth/session state
- product assertions

## OrbStack Machine Setup

Create or update the Linux machine once from the consumer repository:

```bash
bun run setup:e2e
```

By default this:

- creates an OrbStack machine named `<app-name>-e2e`
- installs Bun matching the consumer repo's `packageManager`
- installs the base Linux packages Electrobun needs to build and launch
- prepares `$HOME/code`

Supported config fields:

- `appName`: required, used for default machine and workspace names
- `machineName`: optional override for the OrbStack machine name
- `linuxWorkspaceDir`: optional override for the Linux checkout path
- `machineImage`: optional override, defaults to `ubuntu:24.04`
- `extraAptPackages`: optional extra Ubuntu packages
- `runtimeEnv`: optional extra environment variables for the test run
- `syncExcludes`: optional extra rsync excludes
- `testFileGlobs`: optional discovery globs when no explicit test args are passed
- `testCommand`: optional command override; forwarded args are appended
- `installCommand`: optional install command, defaults to `bun install --frozen-lockfile`
- `buildCommand`: optional build command, defaults to `bun run build`
- `localDependencyPaths`: optional extra sibling-style directories to sync before install

Environment overrides:

- `ELECTROBUN_E2E_ORB_MACHINE`
- `ELECTROBUN_E2E_ORB_WORKSPACE`
- `ELECTROBUN_E2E_LAUNCH_RETRIES`
- `ELECTROBUN_E2E_LAUNCH_RETRY_DELAY_MS`

## Headless Test Runs

Run the full suite from the consumer repository:

```bash
bun run test:e2e
```

Run a subset by forwarding test files after `--`:

```bash
bun run test:e2e -- e2e/smoke.test.ts
```

The shared runner:

- syncs the consumer repo into the Linux machine
- syncs this shared package into a sibling Linux path so `file:../electrobun-e2e` installs still work
- installs synced sibling Bun packages before installing the consumer workspace
- installs dependencies inside the Linux workspace
- builds the Electrobun app
- runs tests under `dbus-run-session` and `xvfb-run`

## What The Consumer Must Provide

- a local sibling dependency on `../electrobun-e2e`
- an `electrobun-e2e.config.ts` file
- app-specific readiness checks for the renderer shell
- app-specific bridge log parsing strategy when the default JSON prefix helper is not enough
- any app-specific temp-home fixtures, control files, or seeded auth/session state
- product assertions and selectors
