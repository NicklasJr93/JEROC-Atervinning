import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(projectDir, 'source-assets');

const pictures = [
  ['office-overview', [1440, 960, 640]],
  ['office-weighing', [1440, 960, 640]],
  ['office-work-orders', [1440, 960, 640]],
  ['mobile-home', [780, 390]],
  ['mobile-weighing', [780, 390]],
  ['yard-illustration', [2172, 1440, 960]],
  ['logo', [2172]],
];

/** Build responsive web assets from the checked-in, unchanged source images. */
export async function prepareAssets(distDir) {
  const assetsDir = join(distDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  await Promise.all(
    pictures.flatMap(([name, widths]) =>
      widths.map(async (width, index) => {
        const filename = `${name}${index === 0 ? '' : `-${width}`}.webp`;
        await sharp(join(sourcesDir, `${name}.png`))
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: name === 'logo' ? 94 : 85, effort: 5 })
          .toFile(join(assetsDir, filename));
      }),
    ),
  );

  const symbol = await readFile(join(projectDir, 'public', 'favicon.svg'));
  await Promise.all([
    sharp(symbol)
      .resize(32, 32)
      .png()
      .toFile(join(assetsDir, 'favicon-32.png')),
    sharp(symbol)
      .resize(180, 180)
      .flatten({ background: '#ffffff' })
      .png()
      .toFile(join(assetsDir, 'apple-touch-icon.png')),
  ]);

  // The approved raster wordmark is preserved; the standalone SP favicon is a vector.
  const logo = await sharp(join(sourcesDir, 'logo.png'))
    .resize(1040)
    .png()
    .toBuffer();
  const footer =
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="110">
    <rect width="1200" height="110" fill="#123047"/>
    <text x="80" y="65" font-family="sans-serif" font-size="26" fill="white">Material · Planering · Personal · Ekonomi</text>
  </svg>`);
  await sharp({
    create: { width: 1200, height: 630, channels: 3, background: '#ffffff' },
  })
    .composite([
      { input: logo, left: 80, top: 105 },
      { input: footer, left: 0, top: 520 },
    ])
    .png()
    .toFile(join(assetsDir, 'social-card.png'));
}
