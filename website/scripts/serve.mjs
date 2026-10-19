import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.env.PORT || 4174);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { ...headers, Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  try {
    const pathname = decodeURIComponent(
      new URL(req.url, 'http://localhost').pathname,
    );
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403, headers);
      res.end();
      return;
    }
    if ((await stat(file)).isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(308, {
          ...headers,
          Location: `${pathname}/${new URL(req.url, 'http://localhost').search}`,
        });
        res.end();
        return;
      }
      file = resolve(file, 'index.html');
    }
    const content = await readFile(file);
    res.writeHead(200, {
      ...headers,
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    const status = error instanceof URIError ? 400 : 404;
    res.writeHead(status, {
      ...headers,
      'Content-Type': 'text/html; charset=utf-8',
    });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : status === 404
          ? await readFile(resolve(root, '404.html')).catch(
              () => 'Kör npm run build först.',
            )
          : 'Ogiltig adress.',
    );
  }
}).listen(port, '0.0.0.0', () =>
  console.log(`ScrapPlanner hemsida: http://localhost:${port}`),
);
