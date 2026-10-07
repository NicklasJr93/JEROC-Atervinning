import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['server/index.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: '3000', EXPO_GO_ENABLED: 'false' },
  }),
  spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0'],
    { stdio: 'inherit' },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 800).unref();
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', (code) => stop(code ?? 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
