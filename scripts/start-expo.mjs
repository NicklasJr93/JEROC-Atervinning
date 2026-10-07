import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expoRoot = resolve(root, 'expo');
const webPort = 4173;
const expoPort = 8081;
const [major, minor] = process.versions.node.split('.').map(Number);
if (
  !(
    (major === 22 && minor >= 13) ||
    (major === 24 && minor >= 3) ||
    major >= 25
  )
) {
  console.error(
    `Expo-demon behöver Node.js 22.13 eller Node.js 24.3+. Du har ${process.versions.node}. Node.js 24 LTS rekommenderas.`,
  );
  process.exit(1);
}
for (const cwd of [root, expoRoot]) {
  if (!existsSync(resolve(cwd, 'package-lock.json'))) {
    console.error(
      'Packa upp hela GitHub-projektet, inklusive expo-mappen, innan du öppnar startfilen.',
    );
    process.exit(1);
  }
}
async function portAvailable(port) {
  return new Promise((accept) => {
    const server = createServer();
    server.once('error', () => accept(false));
    server.listen(port, '0.0.0.0', () => server.close(() => accept(true)));
  });
}
async function webReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${webPort}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return (
      response.ok &&
      (await response.text()).includes('<title>JEROC · Gårdsappen</title>')
    );
  } catch {
    return false;
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
const reuseWeb = await webReady();
if (!reuseWeb && !(await portAvailable(webPort))) {
  console.error(
    `Port ${webPort} används av ett annat program. Stäng det och försök igen.`,
  );
  process.exit(1);
}
console.log('\nJEROC · Expo Go-demo\n');
if (!reuseWeb) {
  console.log('1/3 Installerar och bygger mobilappen…');
  npm(root, ['ci', '--no-audit', '--no-fund']);
  npm(root, ['run', 'build']);
} else console.log('1/3 Använder den JEROC-demo som redan körs på datorn.');
console.log('\n2/3 Installerar Expo-projektets låsta beroenden…');
npm(expoRoot, ['ci', '--no-audit', '--no-fund']);
npm(expoRoot, ['run', 'typecheck']);
const children = [];
let stopping = false;
let exitCode = 0;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  if (!children.some((child) => child.exitCode === null))
    process.exit(exitCode);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('SIGHUP', () => stop());
function start(file, args, options = {}, normalExit = false) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    ...options,
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(`Starten misslyckades: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) {
      if (normalExit && code === 0) stop();
      else {
        console.error('En av demoservrarna har stannat.');
        stop(code || 1);
      }
    }
    if (children.every((c) => c.exitCode !== null || c.signalCode !== null))
      process.exit(exitCode);
  });
  return child;
}
if (!reuseWeb) {
  start(resolve(root, 'node_modules/vite/bin/vite.js'), [
    'preview',
    '--host',
    '0.0.0.0',
    '--port',
    String(webPort),
    '--strictPort',
  ]);
  let ready = false;
  for (let i = 0; i < 120 && !stopping; i++) {
    if (await webReady()) {
      ready = true;
      break;
    }
    await delay(250);
  }
  if (!ready) {
    console.error('Mobilappens server svarade inte.');
    stop(1);
  }
}
if (!stopping) {
  console.log('\n3/3 Startar Expo Go. QR-koden visas nedan.\n');
  console.log(
    'Installera Expo Go på mobilen. Ha dator och mobil på samma wifi.',
  );
  console.log('iPhone: skanna QR-koden med Kamera. Android: skanna i Expo Go.');
  console.log('På iPhone måste Expo Go och Expo CLI vara inloggade på samma Expo-konto. Logga vid behov in med npx expo login i expo-mappen före starten.');
  console.log('Demokonto: niklas / Demo123! Inget skickas till kontoret.');
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
