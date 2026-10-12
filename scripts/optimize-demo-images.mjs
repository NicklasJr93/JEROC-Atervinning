import sharp from 'sharp';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Format/size variants only. Original source images also remain available to PDF
// rendering, existing documents and older clients.
const directory = fileURLToPath(new URL('../public/images/', import.meta.url));
const outputs = [];
await mkdir(path.join(directory, 'catalog'), { recursive: true });
async function save(pipeline, filename, options) {
  const output = path.join(directory, filename);
  await pipeline.webp(options).toFile(output);
  const { width, height } = await sharp(output).metadata();
  outputs.push({ filename, bytes: (await stat(output)).size, width, height });
}

await save(sharp(path.join(directory, 'jeroc-logo-v2.png')).resize({ width: 480, withoutEnlargement: true }), 'jeroc-logo-ui.webp', { lossless: true });
await save(sharp(path.join(directory, 'jeroc-logo-v2.png')).resize({ width: 1200, withoutEnlargement: true }), 'jeroc-logo-print.webp', { lossless: true });
const favicon = path.join(directory, 'jeroc-favicon.png');
await sharp(path.join(directory, 'jeroc-logo-v2.png')).resize({ width: 96 }).png({ compressionLevel: 9 }).toFile(favicon);
const faviconSize = await sharp(favicon).metadata();
outputs.push({ filename: 'jeroc-favicon.png', bytes: (await stat(favicon)).size, width: faviconSize.width, height: faviconSize.height });
await save(sharp(path.join(directory, 'yard.png')).resize({ width: 960, withoutEnlargement: true }), 'yard-960.webp', { quality: 82, effort: 6 });
await save(sharp(path.join(directory, 'yard.png')).resize({ width: 1440, withoutEnlargement: true }), 'yard-1440.webp', { quality: 82, effort: 6 });

for (const atlas of [{ filename: 'materials.png', rows: 7, offset: 0 }, { filename: 'copper-grades.png', rows: 3, offset: 28 }]) {
  const source = path.join(directory, atlas.filename);
  const { width, height } = await sharp(source).metadata();
  if (!width || !height || width % 4 || height % atlas.rows) throw new Error(`Invalid catalog grid: ${atlas.filename}`);
  const cellWidth = width / 4, cellHeight = height / atlas.rows;
  for (let row = 0; row < atlas.rows; row += 1) for (let column = 0; column < 4; column += 1) {
    const index = atlas.offset + row * 4 + column;
    const cell = () => sharp(source).extract({ left: column * cellWidth, top: row * cellHeight, width: cellWidth, height: cellHeight });
    await save(cell().resize({ width: 192, withoutEnlargement: true }), `catalog/${index}-thumb.webp`, { quality: 84, effort: 6 });
    await save(cell(), `catalog/${index}-full.webp`, { quality: 88, effort: 6 });
  }
}

await writeFile(path.join(directory, 'optimized-manifest.json'), `${JSON.stringify({ sourcesPreserved: true, variants: outputs }, null, 2)}\n`);
console.log(JSON.stringify({ files: outputs.length, totalBytes: outputs.reduce((total, output) => total + output.bytes, 0) }));
