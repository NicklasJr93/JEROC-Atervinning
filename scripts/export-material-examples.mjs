import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'public/images/catalog');
const firstId = 40, columns = 4, rows = 2;

/** Export the eight independent photographs in each generated contact sheet.
 * IDs are append-only so existing catalogs and archived document refs stay stable.
 */
export async function exportMaterialExamples(sources, { outDir = destination } = {}) {
  if (sources.length !== 4)
    throw new TypeError('Ange fyra lokala bildark med fyra kolumner och två rader vardera.');
  const boards = await Promise.all(sources.map(async source => {
    const filename = path.resolve(source);
    const file = await stat(filename);
    if (!file.isFile()) throw new TypeError('Varje bildark måste vara en lokal bildfil.');
    const metadata = await sharp(filename, { limitInputPixels: 64_000_000 }).metadata();
    if (!metadata.width || !metadata.height || metadata.width < 768 || metadata.height < 384 || (metadata.pages ?? 1) !== 1)
      throw new TypeError('Bildarket måste vara en stillbild med plats för åtta referensbilder i tillräcklig upplösning.');
    return { filename, width: metadata.width, height: metadata.height };
  }));
  await mkdir(outDir, { recursive: true });
  let totalBytes = 0;
  for (let board = 0; board < boards.length; board++) {
    const { filename, width, height } = boards[board];
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      // Fractional sheet dimensions are assigned once; rounding never overlaps
      // adjoining cells. A narrow inset removes the generated white separator.
      const left = Math.floor(column * width / columns), right = Math.floor((column + 1) * width / columns);
      const top = Math.floor(row * height / rows), bottom = Math.floor((row + 1) * height / rows);
      const inset = Math.max(1, Math.round(Math.min(right - left, bottom - top) * 0.006));
      const region = { left: left + inset, top: top + inset, width: right - left - 2 * inset, height: bottom - top - 2 * inset };
      const id = firstId + board * columns * rows + row * columns + column;
      const cell = () => sharp(filename, { limitInputPixels: 64_000_000 }).extract(region);
      const full = await cell().webp({ quality: 88, effort: 6 }).toFile(path.join(outDir, `${id}-full.webp`));
      const thumb = await cell().resize({ width: 192, withoutEnlargement: true })
        .webp({ quality: 84, effort: 6 }).toFile(path.join(outDir, `${id}-thumb.webp`));
      totalBytes += full.size + thumb.size;
    }
  }
  return { images: 32, files: 64, firstId, lastId: 71, totalBytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await exportMaterialExamples(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Bildarken kunde inte exporteras.');
    process.exitCode = 1;
  }
}
