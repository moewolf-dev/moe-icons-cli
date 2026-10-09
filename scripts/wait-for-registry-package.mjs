import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RETRY_DELAYS_MS = [10_000, 20_000, 40_000, 60_000];
const MAX_WAIT_MS = 30 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 90_000;

function validateIdentity(packageName, version) {
  if (!/^@[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(String(packageName || ''))) {
    throw new Error('package name must be a valid scoped npm package');
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) {
    throw new Error('version must be an exact X.Y.Z release');
  }
}

function isRetryableRegistryFailure(result) {
  const output = `${result?.stderr || ''}\n${result?.stdout || ''}\n${result?.error?.message || ''}`;
  return /(?:\bE404\b|\b404\s+Not Found\b|\b(?:429|500|502|503|504)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|temporary failure|temporarily unavailable|connection reset|unexpected EOF|context deadline exceeded)/i.test(output);
}

function runNpm(command, args) {
  const env = { ...process.env, NPM_CONFIG_USERCONFIG: '/dev/null' };
  delete env.NODE_AUTH_TOKEN;
  delete env.NPM_TOKEN;
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    env,
  });
}

export async function waitForRegistryPackage({
  packageName,
  version,
  runCommand = runNpm,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  maxWaitMs = MAX_WAIT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
} = {}) {
  validateIdentity(packageName, version);
  const startedAt = now();
  let attempt = 0;
  let lastFailure = null;
  while (now() - startedAt < maxWaitMs) {
    attempt += 1;
    const metadata = runCommand('npm', ['view', `${packageName}@${version}`, 'version', '--prefer-online']);
    if (metadata.status === 0) {
      const smoke = runCommand('npx', ['--yes', '--prefer-online', `${packageName}@${version}`, '--version']);
      if (smoke.status === 0) {
        return {
          packageName,
          version,
          attempts: attempt,
          elapsedMs: Math.max(0, now() - startedAt),
          smokeOutput: String(smoke.stdout || '').trim(),
        };
      }
      lastFailure = { command: 'npx package smoke', result: smoke };
      if (!isRetryableRegistryFailure(smoke)) {
        throw new Error(`published package smoke failed permanently (exit ${smoke.status ?? 'unknown'})`);
      }
    } else {
      lastFailure = { command: 'npm registry metadata lookup', result: metadata };
      if (!isRetryableRegistryFailure(metadata)) {
        throw new Error(`npm registry lookup failed permanently (exit ${metadata.status ?? 'unknown'})`);
      }
    }

    const elapsed = now() - startedAt;
    if (elapsed >= maxWaitMs) break;
    const delay = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)];
    await sleep(Math.min(delay, maxWaitMs - elapsed));
  }

  const output = `${lastFailure?.result?.stderr || ''}\n${lastFailure?.result?.stdout || ''}`.trim().slice(-800);
  const detail = output ? `: ${output}` : '';
  throw new Error(
    `npm package ${packageName}@${version} did not become installable within ${maxWaitMs}ms after ${attempt} attempts${lastFailure ? ` (${lastFailure.command})` : ''}${detail}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [packageName, rawVersion] = process.argv.slice(2);
    const version = String(rawVersion || '').replace(/^v/, '');
    const result = await waitForRegistryPackage({ packageName, version });
    if (result.smokeOutput) process.stdout.write(`${result.smokeOutput}\n`);
    process.stdout.write(`npm registry package and npx install verified after ${result.attempts} attempt(s)\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
