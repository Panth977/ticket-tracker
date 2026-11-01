#!/usr/bin/env node
/**
 * Deploy the sandbox gateway to Cloud Run (gateway/Dockerfile).
 *
 *   node scripts/deploy-gateway.mjs --project <id> --region <region> --tm-url https://….web.app
 *
 * Needs the Secret Manager secret TM_GATEWAY_SECRET, which the backend also binds. The
 * service runs as sandbox-runner@, an account that holds no roles.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: { project: { type: 'string' }, region: { type: 'string' }, 'tm-url': { type: 'string' } },
});
if (!a.project || !a.region || !a['tm-url']) throw new Error('--project, --region and --tm-url are required');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'gateway/deploy');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
run('pnpm', ['--filter', '@tm/shared', 'build']);
run('pnpm', [
  '--filter', '@tm/backend', 'exec', 'esbuild', join(ROOT, 'gateway/src/main.ts'), '--bundle', '--platform=node', '--format=esm', '--target=node22',
  `--outfile=${join(OUT, 'gateway.mjs')}`,
  '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
]);
copyFileSync(join(ROOT, 'gateway/Dockerfile'), join(OUT, 'Dockerfile'));
copyFileSync(join(ROOT, 'gateway/start.sh'), join(OUT, 'start.sh'));

const secret = execFileSync(
  'gcloud',
  ['secrets', 'versions', 'access', 'latest', '--secret', 'TM_GATEWAY_SECRET', '--project', a.project],
  { encoding: 'utf8' },
).trim();
const dir = mkdtempSync(join(tmpdir(), 'gw-'));
const envFile = join(dir, 'env.yaml');
writeFileSync(envFile, `TM_URL: ${JSON.stringify(a['tm-url'])}\nTM_GATEWAY_SECRET: ${JSON.stringify(secret)}\n`, { mode: 0o600 });
try {
  run('gcloud', [
    'run', 'deploy', 'sandbox-gateway', '--source', OUT, '--project', a.project, '--region', a.region,
    '--execution-environment', 'gen2', '--allow-unauthenticated',
    '--service-account', `sandbox-runner@${a.project}.iam.gserviceaccount.com`,
    // One instance: a reload and the logs must reach the sandboxes they mean.
    '--memory', '2Gi', '--cpu', '2', '--concurrency', '20', '--min-instances', '0', '--max-instances', '1',
    '--timeout', '60', '--env-vars-file', envFile, '--quiet',
  ]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
