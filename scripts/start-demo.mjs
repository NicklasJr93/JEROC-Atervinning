import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portAvailable, requireLocalRuntime, startLocalServer } from './local-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = 4173;
const url = `http://127.0.0.1:${port}`;
try { requireLocalRuntime(); }
catch (error) { console.error(error.message); process.exit(1); }
if (!existsSync(resolve(root, 'package-lock.json'))) {
  console.error(
    'Hela projektmappen behövs. Ladda ner och packa upp GitHub-projektet innan du öppnar startfilen.',
  );
  process.exit(1);
}
if (!(await portAvailable(port))) {
  console.error(`Port ${port} används redan. Stäng tidigare lokal start och försök igen.`);
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
console.log('\nScrapPlanner · Mobilapp & kontor / lokal demo\n');
console.log('1/3 Installerar projektets låsta beroenden…');
npm(['ci', '--no-audit', '--no-fund']);
console.log('\n2/3 Bygger mobilappen och kontorswebben…');
npm(['run', 'build']);
console.log('\n3/3 Startar appen…');
const startup = new AbortController();
const server = startLocalServer({ root, port, signal: startup.signal });
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  startup.abort();
  void server.stop();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('SIGHUP', () => stop());
server.child.once('exit', code => { if (!stopping) process.exitCode = code ?? 1; });
let ready = false;
try { await server.ready; ready = true; }
catch (error) {
  if (!stopping) { console.error(error.message); stop(1); }
}
if (ready && !stopping) {
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
    '\nWebbappen och API:t delar serverns beständiga lokala databas. Osänt arbete har en lokal återhämtningskö.',
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
