import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig } from '../scripts/build.mjs';

test('a clean checkout targets the agreed public domains and enquiry address', () => {
  assert.deepEqual(readConfig({}), {
    siteUrl: 'https://scrapplanner.com',
    appUrl: 'https://app.scrapplanner.com',
    mobileUrl: 'https://mobile.scrapplanner.com',
    contactEmail: 'nicklas@endorgroup.se',
  });
});

test('a separately deployed site can override origins while an empty recipient keeps the default contact', () => {
  assert.deepEqual(readConfig({
    PUBLIC_SITE_URL: 'https://preview.example.com/',
    APP_URL: 'https://app.example.com/',
    MOBILE_URL: 'https://mobile.example.com/',
    CONTACT_EMAIL: '',
  }), {
    siteUrl: 'https://preview.example.com',
    appUrl: 'https://app.example.com',
    mobileUrl: 'https://mobile.example.com',
    contactEmail: 'nicklas@endorgroup.se',
  });
});

test('public origins reject executable URLs, credentials, paths and query strings', () => {
  const invalidOrigins = [
    'http://example.com', 'javascript:alert(1)', 'data:text/html,test',
    '/relative', 'https://user:password@example.com', 'https://example.com/path',
    'https://example.com/?redirect=https://other.example', 'https://example.com/#fragment',
  ];
  for (const field of ['PUBLIC_SITE_URL', 'APP_URL', 'MOBILE_URL']) {
    for (const value of invalidOrigins) {
      assert.throws(() => readConfig({ [field]: value }), { message: /HTTPS/ }, `${field}: ${value}`);
    }
  }
});

test('recipient configuration cannot inject mail headers or HTML', () => {
  assert.equal(readConfig({ CONTACT_EMAIL: '  sales+demo@example.com  ' }).contactEmail, 'sales+demo@example.com');
  for (const value of [
    'not-an-email', 'sales@example.com\r\nBcc: someone@example.com',
    'sales@example.com?subject=Injected', 'sales@example.com&bcc=other',
    'sales@example.com,other@example.com', '<script>@example.com',
    'sales@', `${'a'.repeat(250)}@example.com`,
  ]) {
    assert.throws(() => readConfig({ CONTACT_EMAIL: value }), { message: /CONTACT_EMAIL/ }, value);
  }
});
