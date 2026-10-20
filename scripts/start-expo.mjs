import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portAvailable, requireLocalRuntime, startLocalServer } from './local-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expoRoot = resolve(root, 'expo');
const webPort = 4173;
const expoPort = 8081;
try { requireLocalRuntime(); }
catch (error) { console.error(error.message); process.exit(1); }
for (const cwd of [root, expoRoot]) {
  if (!existsSync(resolve(cwd, 'package-lock.json'))) {
    console.error(
      'Packa upp hela GitHub-projektet, inklusive expo-mappen, innan du öppnar startfilen.',
    );
    process.exit(1);
  }
}
function npm(cwd, args) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    { cwd, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.error) {
    console.error(
      'npm kunde inte köras. Kontrollera din Node.js-installation.',
    );
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!(await portAvailable(expoPort))) {
  console.error(
    `Port ${expoPort} används redan. Stäng tidigare Expo-start och försök igen.`,
  );
  process.exit(1);
}
if (!(await portAvailable(webPort))) {
  console.error(
    `Port ${webPort} används av ett annat program. Stäng det och försök igen.`,
  );
  process.exit(1);
}
console.log('\nScrapPlanner · Expo Go / lokal demo\n');
console.log('1/3 Installerar och bygger mobilappen och API:t…');
npm(root, ['ci', '--no-audit', '--no-fund']);
npm(root, ['run', 'build']);
console.log('\n2/3 Installerar Expo-projektets låsta beroenden…');
npm(expoRoot, ['ci', '--no-audit', '--no-fund']);
npm(expoRoot, ['run', 'typecheck']);
const startup = new AbortController();
const webServer = startLocalServer({ root, port: webPort, signal: startup.signal });
const children = [webServer.child];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  startup.abort();
  void webServer.stop();
  for (const child of children) {
    if (child === webServer.child || child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    force.unref();
    child.once('exit', () => clearTimeout(force));
  }
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('SIGHUP', () => stop());
webServer.child.once('exit', code => { if (!stopping) stop(code || 1); });
try { await webServer.ready; }
catch (error) {
  if (!stopping) { console.error(error.message); stop(1); }
}
function start(file, args, options = {}, normalExit = false) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    ...options,
  });
  children.push(child);
  child.on('error', error => {
    console.error(`Starten misslyckades: ${error.message}`);
    stop(1);
  });
  child.on('exit', code => {
    if (!stopping) stop(normalExit && code === 0 ? 0 : code || 1);
  });
  return child;
}
if (!stopping) {
  console.log('\n3/3 Startar Expo Go. QR-koden visas nedan.\n');
  console.log(
    'Installera Expo Go på mobilen. Ha dator och mobil på samma wifi.',
  );
  console.log('iPhone: skanna QR-koden med Kamera. Android: skanna i Expo Go.');
  console.log('På iPhone måste Expo Go och Expo CLI vara inloggade på samma Expo-konto. Logga vid behov in med npx expo login i expo-mappen före starten.');
  console.log('Appen, kontoret och API:t körs tillsammans på port 4173. Använd endast lokala testuppgifter.');
  console.log(
    'Låt det här fönstret vara öppet. Ctrl+C stoppar servrarna som denna startfil har startat.\n',
  );
  start(
    resolve(expoRoot, 'node_modules/expo/bin/cli'),
    ['start', '--lan', '--go', '--port', String(expoPort)],
    {
      cwd: expoRoot,
      stdio: 'inherit',
      env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
    },
    true,
  );
}
