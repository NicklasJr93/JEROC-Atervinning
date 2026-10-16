import { createDemoTelematicsStore } from './demo-store.mjs';
import { createDemoTelematicsService } from './demo-service.mjs';

let service, store, maintenance, maintaining = false, stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenance);
  const timeout = setTimeout(() => process.exit(1), 5000); timeout.unref();
  try { await service?.close(); await store?.close(); }
  finally { clearTimeout(timeout); process.exit(code); }
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
// A managed receiver cannot survive its parent and become an orphan listener.
if (process.send) process.on('disconnect', () => { void stop(); });
try {
  store = await createDemoTelematicsStore({ filename: process.env.TELEMATICS_SQLITE_PATH || '.data/telematics-demo/receiver.sqlite',
    databaseUrl: process.env.TELEMATICS_DATABASE_URL || undefined });
  service = await createDemoTelematicsService({ store, token: process.env.TELEMATICS_SERVICE_TOKEN,
    host: process.env.TELEMATICS_HOST || '127.0.0.1', port: Number(process.env.PORT || '3001') });
  maintenance = setInterval(() => {
    if (stopping || maintaining) return;
    maintaining = true;
    void store.ready().catch(() => {}).finally(() => { maintaining = false; });
  }, 60000);
  maintenance.unref();
  if (process.send) process.send({ type: 'telematics-ready', port: service.address.port, storage: store.kind });
  else console.log(`Telematikens syntetiska mottagare lyssnar på port ${service.address.port} (${store.kind}).`);
} catch {
  // No connection strings, tokens, packet contents or database details in logs.
  console.error('Telematikens testmottagare kunde inte starta. Kontrollera dess separata konfiguration.');
  await stop(1);
}
