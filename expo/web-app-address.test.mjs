import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the same pure TypeScript policy used by the native wrapper without
// loading React Native or depending on Node's experimental TS execution.
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./web-app-address.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false });
const { validWebAppAddress, localWebAppAddress, webAppNavigationAllowed, documentAddress } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('configured hosted entry requires HTTPS and mobile entry or legacy demo root, without credentials, query or fragment', () => {
  assert.equal(validWebAppAddress('https://mobile.scrapplanner.com/mobil/', true), true);
  assert.equal(validWebAppAddress('https://another.example.test:8443/mobil/', true), true);
  assert.equal(validWebAppAddress('https://legacy-demo.example.invalid/', true), true, 'a fixed hosted demo root still opens after updating');
  for (const value of [
    '', 'not a URL', '/mobil/', '//mobile.scrapplanner.com/mobil/',
    'http://mobile.scrapplanner.com/mobil/', 'http://192.168.1.7:4173/mobil/',
    'https://mobile.scrapplanner.com/mobil',
    'https://mobile.scrapplanner.com/mobil/orders', 'https://mobile.scrapplanner.com/%6dobil/',
    'https://user@mobile.scrapplanner.com/mobil/', 'https://user:secret@mobile.scrapplanner.com/mobil/',
    'https://mobile.scrapplanner.com/mobil/?company=example', 'https://mobile.scrapplanner.com/mobil/#/orders',
    'javascript:alert(1)', 'data:text/html,example', 'file:///mobil/',
  ]) assert.equal(validWebAppAddress(value, true), false, value);
});

test('unconfigured demo permits HTTPS but confines plain HTTP to private or local hosts, including subnet boundaries', () => {
  for (const value of [
    'https://public.example.test/any/path', 'https://public.example.test:8443/',
    'http://localhost:4173/', 'http://127.0.0.1:4173/', 'http://127.255.255.254:4173/',
    'http://[::1]:4173/', 'http://workstation.local:4173/',
    'http://10.0.0.1:4173/', 'http://10.255.255.254:4173/',
    'http://192.168.0.1:4173/', 'http://192.168.255.254:4173/',
    'http://172.16.0.1:4173/', 'http://172.31.255.254:4173/',
    'http://169.254.0.1:4173/', 'http://169.254.255.254:4173/',
  ]) assert.equal(validWebAppAddress(value, false), true, value);
  for (const value of [
    'http://public.example.test/', 'http://localhost.evil.test/', 'http://workstation.local.evil.test/',
    'http://11.0.0.1/', 'http://126.255.255.254/', 'http://192.167.255.254/',
    'http://172.15.255.254/', 'http://172.32.0.1/', 'http://169.253.255.254/',
    'http://0.0.0.0/', 'http://[::]/', 'http://[2001:db8::1]/',
    'http://user@192.168.1.7/', 'https://user:secret@public.example.test/',
    'http://192.168.1.7/?company=example', 'https://public.example.test/#/orders',
    'ftp://192.168.1.7/', 'file:///tmp/index.html',
  ]) assert.equal(validWebAppAddress(value, false), false, value);
});

test('Expo host discovery derives only a private LAN HTTP entry and never falls back to a public server', () => {
  for (const [hostUri, expected] of [
    ['192.168.1.33:8081', 'http://192.168.1.33:4173/'],
    ['http://10.1.2.3:8081', 'http://10.1.2.3:4173/'],
    ['https://172.16.0.4:8081/expo', 'http://172.16.0.4:4173/'],
    ['localhost:8081', 'http://localhost:4173/'],
    ['[::1]:8081', 'http://[::1]:4173/'],
    ['workstation.local:8081', 'http://workstation.local:4173/'],
  ]) assert.equal(localWebAppAddress(hostUri), expected, hostUri);
  for (const hostUri of [undefined, '', 'not a host uri', 'expo.example.test:8081',
    'https://public.example.test/expo', '172.32.0.1:8081', '192.167.1.33:8081', 'localhost.evil.test:8081'])
    assert.equal(localWebAppAddress(hostUri), '', String(hostUri));
});

test('WebView navigation stays on its exact HTTP(S) origin and rejects credential, port and lookalike escapes', () => {
  const origin = 'https://mobile.scrapplanner.com';
  for (const value of [origin, `${origin}/`, `${origin}/mobil/#/orders`, `${origin}/mobil/?company=example`,
    'https://MOBILE.SCRAPPLANNER.COM:443/mobil/']) assert.equal(webAppNavigationAllowed(value, origin), true, value);
  for (const value of [
    'http://mobile.scrapplanner.com/mobil/', 'https://mobile.scrapplanner.com:444/mobil/',
    'https://mobile.scrapplanner.com.evil.test/mobil/', 'https://evil.test/mobile.scrapplanner.com/',
    'https://mobile.scrapplanner.com@evil.test/', 'https://evil.test@mobile.scrapplanner.com/',
    '//mobile.scrapplanner.com/mobil/', '/mobil/', '', 'not a URL',
    'javascript:alert(1)', 'data:text/html,example', 'blob:https://mobile.scrapplanner.com/identifier',
    'about:blank', 'about:srcdoc', 'file:///mobil/',
  ]) assert.equal(webAppNavigationAllowed(value, origin), false, value);
  assert.equal(webAppNavigationAllowed('http://192.168.1.33:4173/mobil/', 'http://192.168.1.33:4173'), true);
  assert.equal(webAppNavigationAllowed('http://192.168.1.33:4174/mobil/', 'http://192.168.1.33:4173'), false);
  assert.equal(webAppNavigationAllowed(`${origin}/mobil/`, ''), false);
});

test('document matching ignores SPA hashes but retains query and resource paths so a child HTTP error is not mistaken for page failure', () => {
  const page = 'https://mobile.scrapplanner.com/mobil/?company=example';
  assert.equal(documentAddress(`${page}#/orders/42`), page);
  assert.equal(documentAddress('https://MOBILE.SCRAPPLANNER.COM:443/mobil/#/orders'), 'https://mobile.scrapplanner.com/mobil/');
  assert.equal(documentAddress('https://mobile.scrapplanner.com'), 'https://mobile.scrapplanner.com/');
  assert.notEqual(documentAddress(`${page}#/orders`), documentAddress('https://mobile.scrapplanner.com/mobil/?company=another'));
  assert.notEqual(documentAddress(`${page}#/orders`), documentAddress('https://mobile.scrapplanner.com/api/employee/session'));
  assert.notEqual(documentAddress(`${page}#/orders`), documentAddress('https://mobile.scrapplanner.com/images/favicon.png'));
  for (const value of ['', 'not a URL', '/mobil/', '//mobile.scrapplanner.com/mobil/']) assert.equal(documentAddress(value), '', value);
});
