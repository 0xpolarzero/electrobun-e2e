const DEFAULT_TRANSIENT_LINUX_LAUNCH_PATTERNS = [
  "timed out waiting for bridge metadata",
  "timed out connecting to electrobun bridge",
  "exited before the bridge became available",
  "glxbadwindow",
  "segmentation fault",
  "pas panic",
  "large heap did not find object",
  "child process terminated by signal: 5",
  "child process terminated by signal: 6",
];

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTransientLinuxLaunchRetryCount(): number {
  return parsePositiveInteger(process.env.ELECTROBUN_E2E_LAUNCH_RETRIES, 0);
}

export function getTransientLinuxLaunchRetryDelayMs(): number {
  return parsePositiveInteger(process.env.ELECTROBUN_E2E_LAUNCH_RETRY_DELAY_MS, 750);
}

export function shouldRetryTransientLinuxLaunchFailure(
  errorMessage: string,
  attempt: number,
  maxRetries = getTransientLinuxLaunchRetryCount(),
  patterns = DEFAULT_TRANSIENT_LINUX_LAUNCH_PATTERNS,
): boolean {
  if (process.platform !== "linux" || attempt >= maxRetries) {
    return false;
  }

  const normalized = errorMessage.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

export async function withTransientLinuxLaunchRetries<T>(
  label: string,
  run: () => Promise<T>,
  patterns = DEFAULT_TRANSIENT_LINUX_LAUNCH_PATTERNS,
): Promise<T> {
  const maxRetries = getTransientLinuxLaunchRetryCount();

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!shouldRetryTransientLinuxLaunchFailure(errorMessage, attempt, maxRetries, patterns)) {
        throw error;
      }

      const retryNumber = attempt + 1;
      const summary = errorMessage.split("\n", 1)[0] ?? errorMessage;
      console.warn(
        `${label}: retrying transient Linux launch failure (${retryNumber}/${maxRetries}): ${summary}`,
      );
      await Bun.sleep(getTransientLinuxLaunchRetryDelayMs());
    }
  }
}
