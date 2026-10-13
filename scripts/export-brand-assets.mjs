import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';
import PDFDocument from 'pdfkit';

// SVG masters are the only source for production assets. The wordmark uses
// outline paths, so exports do not depend on installed fonts or raster sources.
const root = fileURLToPath(new URL('../', import.meta.url));
const branding = path.join(root, 'docs/branding'), images = path.join(root, 'public/images');
const native = path.join(root, 'expo/assets');
await Promise.all([mkdir(images, { recursive: true }), mkdir(native, { recursive: true })]);
const logoPath = path.join(branding, 'scrappilot-logo.svg'), symbolPath = path.join(branding, 'scrappilot-symbol.svg');
const logo = await readFile(logoPath), symbol = await readFile(symbolPath);
await copyFile(logoPath, path.join(images, 'scrappilot-logo.svg'));
await copyFile(symbolPath, path.join(images, 'scrappilot-symbol.svg'));
await copyFile(symbolPath, path.join(root, 'public/icon.svg'));
await sharp(logo).resize({ width: 1914 }).png().toFile(path.join(branding, 'scrappilot-logo-vector.png'));
await sharp(symbol).resize(1024, 1024).png().toFile(path.join(branding, 'scrappilot-symbol-vector.png'));
await sharp(logo).resize({ width: 1200 }).png().toFile(path.join(images, 'scrappilot-logo.png'));
await sharp(symbol).resize(512, 512).png().toFile(path.join(images, 'scrappilot-symbol.png'));

async function icon(size, inset, background) {
  const contentSize = Math.round(size * (1 - 2 * inset));
  const mark = await sharp(symbol).resize(contentSize, contentSize).png().toBuffer();
  const canvas = sharp({ create: { width: size, height: size, channels: 4,
    background: background ?? { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite([{ input: mark, gravity: 'centre' }]);
  // Apple launcher icons must have no alpha channel, even when all pixels are opaque.
  return (background ? canvas.removeAlpha() : canvas).png().toBuffer();
}
const favicons = [];
for (const size of [16, 32, 48]) {
  const data = await icon(size, 0, null);
  favicons.push({ size, data });
  await writeFile(path.join(images, `favicon-${size}.png`), data);
}
// ICO directory with PNG-compressed frames; browsers can choose 16/32/48 px.
const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(favicons.length, 4);
let offset = 6 + 16 * favicons.length;
const entries = favicons.map(({ size, data }) => {
  const entry = Buffer.alloc(16); entry[0] = size; entry[1] = size;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8); entry.writeUInt32LE(offset, 12); offset += data.length;
  return entry;
});
await writeFile(path.join(root, 'public/favicon.ico'), Buffer.concat([header, ...entries, ...favicons.map(frame => frame.data)]));
await writeFile(path.join(images, 'apple-touch-icon.png'), await icon(180, 0.06, '#FFFFFF'));
for (const size of [192, 512]) await writeFile(path.join(images, `app-icon-${size}.png`), await icon(size, 0.06, '#FFFFFF'));
await writeFile(path.join(native, 'icon.png'), await icon(1024, 0.06, '#FFFFFF'));
// Android masks/crops the foreground: keep the actual mark inside its safe zone.
await writeFile(path.join(native, 'adaptive-icon.png'), await icon(1024, 0.20, null));
const splashLogo = await sharp(logo).resize({ width: 1536 }).png().toBuffer();
await sharp({ create: { width: 2048, height: 768, channels: 4, background: '#FFFFFF' } })
  .composite([{ input: splashLogo, gravity: 'centre' }]).png().toFile(path.join(native, 'splash.png'));

// The logo master consists entirely of filled paths with translations.
// Export those paths directly to PDF, rather than embedding a raster image.
const svg = logo.toString('utf8');
const viewBox = svg.match(/viewBox="([\d. ]+)"/)?.[1]?.split(/\s+/).map(Number);
if (!viewBox || viewBox.length !== 4 || viewBox[0] || viewBox[1] || /<(?:image|text|g)\b/.test(svg))
  throw new Error('Print export requires the outlined logo master without groups, images or text.');
const doc = new PDFDocument({ size: [viewBox[2] / 2, viewBox[3] / 2], margin: 0,
  info: { Title: 'ScrapPilot – blå/grön logga', Author: 'ScrapPilot', Creator: 'ScrapPilot SVG export' } });
const output = createWriteStream(path.join(branding, 'scrappilot-logo-print.pdf')); doc.pipe(output);
doc.scale(0.5);
for (const tag of svg.matchAll(/<path\b[^>]*\/>/g)) {
  const attributes = Object.fromEntries([...tag[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
  const position = attributes.transform?.match(/^translate\(([-\d.]+)[, ]+([-\d.]+)\)$/);
  if (!attributes.d || !/^#[a-f\d]{6}$/i.test(attributes.fill) || attributes.transform && !position)
    throw new Error('Unsupported SVG path in print export.');
  doc.save();
  if (position) doc.translate(Number(position[1]), Number(position[2]));
  doc.path(attributes.d).fill(attributes.fill).restore();
}
doc.end(); await finished(output);
console.log('ScrapPilot SVG masters exported to web, native icons, PNG and vector PDF.');
