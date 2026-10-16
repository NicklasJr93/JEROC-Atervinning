import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createDemoTelematicsClient, validateDemoEndpoint } from './demo-client.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const unavailable = () => Object.assign(new Error('telematics_demo_unavailable'), { code: 'telematics_demo_unavailable' });

/** Lazy child service: its SQLite work never runs on the CRM event loop.
 * This shares the host's CPU/disk, not a production isolation/scaling guarantee.
 * An explicit URL+token replaces the child when dedicated hosting is supplied.
 */
export function createDemoReceiverRuntime({ env = process.env, startupTimeoutMs = 7000, spawnImpl = spawn } = {}) {
  let remoteUrl = null, configurationInvalid = false;
  try { remoteUrl = env.TELEMATICS_SERVICE_URL ? validateDemoEndpoint(env.TELEMATICS_SERVICE_URL) : null; }
  catch { configurationInvalid = true; }
  const remoteToken = env.TELEMATICS_SERVICE_TOKEN;
  if (remoteUrl && (typeof remoteToken !== 'string' || Buffer.byteLength(remoteToken) < 32))
    configurationInvalid = true;
  let child = null, pending = null, address = null, closed = false, retryAt = 0;
  const children = new Set();
  const token = remoteUrl ? remoteToken : randomBytes(32).toString('base64url');
  async function ready() {
    if (closed || configurationInvalid) throw unavailable();
    if (remoteUrl) return { url: remoteUrl, token };
    if (address) return { url: address, token };
    if (Date.now() < retryAt) throw unavailable();
    if (pending) return pending;
    // A failed startup must exit before another process can take its place.
    if (child) throw unavailable();
    pending = new Promise((accept, reject) => {
      let settled = false;
      const finish = failure => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (failure) { address = null; retryAt = Date.now() + 3000; reject(unavailable()); }
        else accept({ url: address, token });
      };
      const timer = setTimeout(() => {
        finish(true); processChild?.kill('SIGTERM');
        const force = setTimeout(() => { if (children.has(processChild)) processChild.kill('SIGKILL'); }, 500); force.unref();
        processChild?.once('exit', () => clearTimeout(force));
      }, startupTimeoutMs); timer.unref();
      let processChild;
      try {
        // The child receives no CRM connection strings or integration secrets.
        processChild = spawnImpl(process.execPath, [fileURLToPath(new URL('./demo-main.mjs', import.meta.url))], {
          cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {
            ...(env.PATH && { PATH: env.PATH }), ...(env.NODE_EXTRA_CA_CERTS && { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS }),
            ...(env.NODE_ENV && { NODE_ENV: env.NODE_ENV }),
            PORT: '0', TELEMATICS_HOST: '127.0.0.1', TELEMATICS_SERVICE_TOKEN: token,
            TELEMATICS_SQLITE_PATH: resolve(root, env.TELEMATICS_SQLITE_PATH || '.data/telematics-demo/receiver.sqlite'),
            ...(env.TELEMATICS_DATABASE_URL && { TELEMATICS_DATABASE_URL: env.TELEMATICS_DATABASE_URL }),
          },
        });
        child = processChild; children.add(processChild);
        processChild.on('message', message => {
          if (settled || child !== processChild || closed || message?.type !== 'telematics-ready'
            || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
          address = `http://127.0.0.1:${message.port}`; finish(false);
        });
        processChild.once('error', () => {
          if (!processChild.pid) { children.delete(processChild); if (child === processChild) child = null; }
          finish(true);
        });
        processChild.once('exit', () => {
          children.delete(processChild);
          if (child === processChild) { child = null; address = null; retryAt = Date.now() + 3000; }
          finish(true);
        });
      } catch { finish(true); }
    });
    const result = pending;
    void result.finally(() => { if (pending === result) pending = null; }).catch(() => {});
    return result;
  }
  return { ready,
    createClient: () => createDemoTelematicsClient({ endpoint: ready }),
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...children].map(current => new Promise(resolve => {
        const timeout = setTimeout(() => { current.kill('SIGKILL'); resolve(); }, 3000); timeout.unref();
        current.once('exit', () => { clearTimeout(timeout); resolve(); }); current.kill('SIGTERM');
      })));
    },
  };
}
