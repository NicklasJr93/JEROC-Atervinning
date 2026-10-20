import sharp from 'sharp';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcesDir = join(projectDir, 'source-assets');

const heroWidths = [640, 960, 1440, 1920];

/** Build the approved public artwork. Product previews are synthetic HTML UI. */
export async function prepareAssets(distDir) {
  const assetsDir = join(distDir, 'assets');
  await mkdir(assetsDir, { recursive: true });

  // Only this curated illustration and the wordmark are published. Internal
  // application screenshots are deliberately excluded from the public build.
  await Promise.all([
    ...heroWidths.map((width) =>
      sharp(join(sourcesDir, 'industrial-hero.png'))
        .resize({ width })
        .webp({ quality: 84, effort: 5 })
        .toFile(join(assetsDir, `hero-${width}.webp`)),
    ),
    sharp(join(sourcesDir, 'logo.png'))
      .webp({ quality: 94, effort: 5 })
      .toFile(join(assetsDir, 'logo.webp')),
    copyFile(
      join(sourcesDir, 'fonts', 'nunito-variable.woff2'),
      join(assetsDir, 'nunito-variable.woff2'),
    ),
    copyFile(
      join(sourcesDir, 'fonts', 'Nunito-OFL.txt'),
      join(assetsDir, 'Nunito-OFL.txt'),
    ),
  ]);

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
