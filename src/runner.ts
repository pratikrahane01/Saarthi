import { spawn, spawnSync } from 'child_process';
import path from 'path';

/** Shape returned by runTests — intentionally free of raw log data. */
export interface TestResult {
  /** True when the test runner exited with code 0. */
  passed: boolean;
  /** Wall-clock duration of the test run in milliseconds. */
  duration: number;
}

/**
 * Probes the system to find the appropriate executable for the given language.
 * - For 'python': tries `python3` first, falls back to `python`.
 * - For 'node':   returns `node` directly.
 *
 * @throws {Error} If no suitable executable is found on the system.
 */
export function detectExecutable(language: 'python' | 'node'): string {
  if (language === 'node') {
    return 'node';
  }

  // Try python3 first, then fall back to python
  const candidates = ['python3', 'python'];

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
    });

    // spawnSync sets result.error when the binary isn't found at all
    // and returns a non-zero status when it errors at runtime.
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  throw new Error(
    'No Python executable found. Please install Python 3 and ensure it is on your PATH.'
  );
}

export async function runTests(
  testFilePath: string,
  language: 'python' | 'node'
): Promise<TestResult> {
  const executable = detectExecutable(language);
  const resolvedPath = path.resolve(testFilePath);

  // Build the argument list for the chosen test runner.
  // pytest  : python3 -m pytest <file>
  // jest    : node   --experimental-vm-modules node_modules/.bin/jest <file>
  const args: string[] =
    language === 'python'
      ? ['-m', 'pytest', resolvedPath]
      : [path.join('node_modules', '.bin', 'jest'), resolvedPath];

  const TIMEOUT_MS = 15_000;
  const startTime = Date.now();

  const result = await new Promise<TestResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      // Discard stdout/stderr — callers receive only the structured result.
      stdio: 'ignore',
    });

    // Kill the child and resolve with a capped failure result after 15 s.
    const timer = setTimeout(() => {
      child.kill();
      resolve({ passed: false, duration: TIMEOUT_MS });
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      // code can be null if the process was killed by a signal; treat as failure.
      resolve({
        passed: code === 0,
        duration: Date.now() - startTime,
      });
    });
  });

  return result;
}
