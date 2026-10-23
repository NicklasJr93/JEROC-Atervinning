import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer } from './local-server.mjs';

// Tests must never inherit production databases or grant an automatic session.
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'bokforing-regression-'));
const env = {
  PATH: process.env.PATH, NODE_ENV: 'test', DATABASE_URL: '',
  SCRAPPLANNER_DEPLOYMENT_MODE: 'demo', JEROC_DEMO_AUTO_SESSION: 'false',
  SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Isolated-Bookkeeping-Regression-Test-2026!',
  JEROC_TENANT_DATA_DIR: directory,
};
for (const name of ['APPLICATION', 'PLATFORM', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA']) {
  env[`JEROC_${name}_DB_PATH`] = join(directory, `${name.toLowerCase()}.sqlite`);
}
const server = startLocalServer({ root, port: 4179, env, timeoutMs: 30000, stdio: 'inherit' });
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await server.stop();
  await rm(directory, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
server.child.once('exit', () => { if (!stopping) void stop(1); });
try { await server.ready; } catch (error) { console.error(error.message); await stop(1); }
