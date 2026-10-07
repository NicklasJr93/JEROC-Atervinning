import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 4173;
const url = `http://127.0.0.1:${port}`;
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `Du har Node.js ${process.versions.node}. JEROC behöver Node.js 22.12 eller senare.`,
  );
  process.exit(1);
}
if (!existsSync(resolve(root, 'package-lock.json'))) {
  console.error(
    'Hela projektmappen behövs. Ladda ner och packa upp GitHub-projektet innan du öppnar startfilen.',
  );
  process.exit(1);
}
try {
  await new Promise((accept, reject) => {
    const check = createServer();
    check.once('error', reject);
    check.listen(port, '0.0.0.0', () => check.close(accept));
  });
} catch {
  console.error(
    `Port ${port} används redan. Stäng en tidigare JEROC-start eller programmet som använder porten och försök igen.`,
  );
  process.exit(1);
}
function npm(args) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (result.error) {
    console.error(
      'npm kunde inte köras. Kontrollera att din Node.js-installation innehåller npm.',
    );
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('\nJEROC Återvinning · Mobilapp & kontor / demo\n');
console.log('1/3 Installerar projektets låsta beroenden…');
npm(['ci', '--no-audit', '--no-fund']);
console.log('\n2/3 Bygger mobilappen och kontorswebben…');
npm(['run', 'build']);
console.log('\n3/3 Startar appen…');
const server = spawn(process.execPath, [resolve(root, 'server/index.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port), EXPO_GO_ENABLED: 'false' },
});
let stopping = false;
let exitCode = 0;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop());
process.on('SIGHUP', () => stop());
server.on('error', (error) => {
  console.error(`Servern kunde inte starta: ${error.message}`);
  process.exit(1);
});
server.on('exit', (code) => process.exit(stopping ? exitCode : (code ?? 1)));
let ready = false;
for (let i = 0; i < 120 && !stopping; i++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    if (response.ok && (await response.text()).includes('JEROC')) {
      ready = true;
      break;
    }
  } catch {
    /* Retry while our own server starts. */
  }
  await delay(250);
}
if (!ready) {
  console.error(
    'Servern svarade inte. Läs felmeddelandet ovan och försök igen.',
  );
  exitCode = 1;
  stop();
} else {
  console.log(`\nKlart! Öppna ${url}`);
  console.log('Mobilens demokonto: niklas / Demo123!');
  console.log(`Kontorswebben: ${url}/kontor · välj ett demokonto där`);
  const addresses = new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n.address),
  );
  for (const address of addresses)
    console.log(`På mobilen i samma wifi: http://${address}:${port}`);
  console.log(
    '\nMobilutkast sparas i webbläsaren. Kontorets prisregler sparas i serverns minne under denna körning.',
  );
  console.log('Låt det här fönstret vara öppet. Stoppa appen med Ctrl+C.\n');
  if (!process.argv.includes('--no-open')) {
    const browser =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/c', 'start', '', url], {
            detached: true,
            stdio: 'ignore',
          })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    browser.on('error', () => console.log(`Öppna adressen manuellt: ${url}`));
    browser.unref();
  }
}
