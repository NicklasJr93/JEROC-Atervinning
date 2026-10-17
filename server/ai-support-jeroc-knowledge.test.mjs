import test from 'node:test';
import assert from 'node:assert/strict';
import { getJerocKnowledgePack, isJerocKnowledgePackEligible, JEROC_KNOWLEDGE_PACK_ID, JEROC_KNOWLEDGE_PACK_VERSION } from './ai-support-jeroc-knowledge.mjs';

test('JEROC starter content requires the exact trusted organisation identifier', () => {
  for (const options of [undefined, {}, { organisationId: 'other', companyName: 'JEROC' }, { organisationId: 'JEROC-demo' }, { organisationId: 'jeroc-demo-other' }, { organisationId: 'jeroc-demo ' }]) {
    assert.equal(isJerocKnowledgePackEligible(options), false); assert.equal(getJerocKnowledgePack(options), null);
  }
  assert.equal(isJerocKnowledgePackEligible({ organisationId: 'jeroc-demo' }), true);
  const pack = getJerocKnowledgePack({ organisationId: 'jeroc-demo' });
  assert.equal(pack.id, JEROC_KNOWLEDGE_PACK_ID); assert.equal(pack.version, JEROC_KNOWLEDGE_PACK_VERSION);
});

test('curated FAQs fit normal publication limits and contain no publication decision, demo location or disputed hours', () => {
  const pack = getJerocKnowledgePack({ organisationId: 'jeroc-demo' });
  assert.equal(pack.items.length, 12); assert.equal(new Set(pack.items.map(item => item.id)).size, pack.items.length);
  assert.ok(pack.items.reduce((sum, item) => sum + item.title.length + item.answer.length, 0) < 10_000);
  for (const item of pack.items) {
    assert.deepEqual(Object.keys(item).sort(), ['answer', 'category', 'id', 'siteIds', 'sources', 'title']);
    assert.ok(item.title.length <= 160); assert.ok(item.answer.length <= 3000); assert.deepEqual(item.siteIds, []);
    assert.ok(['general', 'materials', 'opening_hours', 'visits', 'pickups', 'payments'].includes(item.category));
  }
  const text = pack.items.map(item => `${item.title}\n${item.answer}`).join('\n');
  assert.doesNotMatch(text, /lördag|09[–-]14|10[–-]14|761(?:41|48|97)|[ÄÅ]ngsvägen|Tegelbruksvägen|\b\d+(?:[,.]\d+)?\s*(?:kr|SEK)\b/i);
  assert.match(pack.items.find(item => item.id === 'cable').answer, /Ja, JEROC köper kabelskrot/);
  assert.match(pack.items.find(item => item.id === 'cable').answer, /kopparkabel/);
  assert.match(pack.items.find(item => item.id === 'norrtalje-visit').answer, /Argonvägen 12/);
  assert.match(pack.items.find(item => item.id === 'norrtalje-visit').answer, /måndag till fredag klockan 08–17/);
  assert.match(pack.items.find(item => item.id === 'whitegoods').answer, /inte kyl eller frys/);
});

test('public sources are fixed review metadata and callers cannot mutate later pack reads', () => {
  const options = { organisationId: 'jeroc-demo' }, first = getJerocKnowledgePack(options), expected = getJerocKnowledgePack(options);
  for (const item of first.items) {
    assert.ok(item.sources.length);
    for (const source of item.sources) {
      const url = new URL(source.url); assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'www.jeroc.se'); assert.equal(url.username, ''); assert.equal(url.password, '');
      assert.ok(source.title); assert.equal(source.verifiedAt, '2026-10-17'); assert.equal(item.answer.includes(source.url), false);
    }
  }
  first.items[0].answer = 'Changed private text'; first.items[0].sources[0].url = 'https://foreign.invalid'; first.items.pop();
  assert.deepEqual(getJerocKnowledgePack(options), expected);
});
