import test from 'node:test';
import assert from 'node:assert/strict';
import { articles } from '../public/bokforing/wiki/content.js';
import { ANDE_KNOWLEDGE_VERSION, andeKnowledge, getAndeCitations } from './bokforing-ande-knowledge.mjs';

test('Ande knowledge fits its input budget and references existing wiki articles or official sources', () => {
  assert.match(ANDE_KNOWLEDGE_VERSION, /^SE-demo-2026-10-23\./);
  assert.ok(andeKnowledge.length >= 8 && andeKnowledge.length <= 12);
  assert.ok(JSON.stringify(andeKnowledge).length <= 15_000);
  assert.equal(new Set(andeKnowledge.map(item => item.id)).size, andeKnowledge.length);
  const wikiIds = new Set(articles.map(article => article.id));
  for (const item of andeKnowledge) {
    assert.ok(item.title && item.text);
    if (item.url.startsWith('/bokforing/wiki/#artikel/')) {
      assert.ok(wikiIds.has(item.url.split('/').at(-1)), `Unknown wiki reference ${item.url}`);
    } else {
      const url = new URL(item.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(['www.bfn.se', 'www.skatteverket.se'].includes(url.hostname));
      assert.equal(url.username, '');
      assert.equal(url.password, '');
    }
  }
});

test('Model-selected citations can only return server-owned links', () => {
  const requested = ['https://malicious.example/', 'vat-demo', 'vat-demo', '__proto__', 'javascript:alert(1)', 'bfn-guidance'];
  const citations = getAndeCitations(requested);
  assert.deepEqual(citations.map(item => item.id), ['vat-demo', 'bfn-guidance']);
  assert.equal(citations[0].url, '/bokforing/wiki/#artikel/moms-utland');
  assert.equal(getAndeCitations(andeKnowledge.map(item => item.id)).length, 6);
  assert.deepEqual(getAndeCitations({ url: 'https://malicious.example/' }), []);
  citations[0].url = 'https://malicious.example/';
  assert.equal(getAndeCitations(['vat-demo'])[0].url, '/bokforing/wiki/#artikel/moms-utland');
});
