import { build } from 'esbuild';
await build({ entryPoints: ['server/domain-models.ts'], outfile: 'dist-server/domain-models.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
