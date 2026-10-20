import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

// Reuse the approved website artwork. The wordmark is a raster original;
// only its outer presentation margins are removed for the application header.
const root = fileURLToPath(new URL('../', import.meta.url));
const images = path.join(root, 'public/images');
const symbolPath = path.join(root, 'website/public/favicon.svg');
const symbol = await readFile(symbolPath);
await sharp(path.join(root, 'website/source-assets/logo.png'))
  .trim({ background: '#ffffff', threshold: 30 })
  .extend({ top: 8, bottom: 8, left: 8, right: 8, background: '#ffffff' })
  .png({ compressionLevel: 9 })
  .toFile(path.join(images, 'scrapplanner-logo.png'));
await copyFile(symbolPath, path.join(images, 'scrapplanner-symbol.svg'));
await copyFile(symbolPath, path.join(root, 'public/icon.svg'));

async function icon(size, inset = 0, background) {
  const contentSize = Math.round(size * (1 - 2 * inset));
  const mark = await sharp(symbol).resize(contentSize, contentSize).png().toBuffer();
  const canvas = sharp({ create: { width: size, height: size, channels: 4,
    background: background ?? { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite([{ input: mark, gravity: 'centre' }]);
  return (background ? canvas.removeAlpha() : canvas).png().toBuffer();
}

const frames = [];
for (const size of [16, 32, 48]) {
  const data = await icon(size);
  frames.push({ size, data });
  await writeFile(path.join(images, `favicon-${size}.png`), data);
}
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
let offset = 6 + 16 * frames.length;
const entries = frames.map(({ size, data }) => {
  const entry = Buffer.alloc(16); entry[0] = size; entry[1] = size;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12);
  offset += data.length;
  return entry;
});
await writeFile(path.join(root, 'public/favicon.ico'),
  Buffer.concat([header, ...entries, ...frames.map(frame => frame.data)]));
await writeFile(path.join(images, 'apple-touch-icon.png'), await icon(180, 0.06, '#ffffff'));
for (const size of [192, 512])
  await writeFile(path.join(images, `app-icon-${size}.png`), await icon(size, 0.06, '#ffffff'));
const native = path.join(root, 'expo/assets');
await writeFile(path.join(native, 'icon.png'), await icon(1024, 0.06, '#ffffff'));
await writeFile(path.join(native, 'adaptive-icon.png'), await icon(1024, 0.20));
const splashLogo = await sharp(path.join(images, 'scrapplanner-logo.png')).resize({ width: 1536 }).png().toBuffer();
await sharp({ create: { width: 2048, height: 768, channels: 4, background: '#ffffff' } })
  .composite([{ input: splashLogo, gravity: 'centre' }]).png().toFile(path.join(native, 'splash.png'));
console.log('ScrapPlanner website artwork exported to application logo, browser and native icons.');
