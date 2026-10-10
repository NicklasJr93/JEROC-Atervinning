import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mergeRecord } from './application.mjs';

const bundle = await build({ entryPoints: [new URL('../src/shared-data.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { rebaseConfirmedChanges } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const original = () => ({ cards: [{ id: 1, status: 'complement', origin: 'Gård 1', reference: '', customerApproval: undefined }, { id: 2, status: 'new', origin: 'Gård 2', reference: '' }], customers: [{ id: 'c1', name: 'Kund' }] });
const confirm = data => ({ ...data, cards: data.cards.map(card => card.id === 1 ? { ...card, status: 'customer', customerApproval: { id: 'review', status: 'waiting' } } : card) });

test('acknowledgement retains same-card input and independent edits while advancing workflow fields', () => {
 const base = original(), next = structuredClone(base); next.cards[0].origin = 'Ny adress'; next.cards[1].reference = 'Separat arbete'; next.customers[0].name = 'Uppdaterad kund';
 const rebased = rebaseConfirmedChanges(base, next, confirm(base));
 assert.equal(rebased.next.cards[0].origin, 'Ny adress'); assert.equal(rebased.next.cards[0].status, 'customer'); assert.equal(rebased.base.cards[0].status, 'customer');
 assert.equal(rebased.next.cards[1].reference, 'Separat arbete'); assert.equal(rebased.next.customers[0].name, 'Uppdaterad kund');
 assert.equal(mergeRecord(confirm(base).cards[0], rebased.base.cards[0], rebased.next.cards[0]).origin, 'Ny adress');
});

test('a competing acknowledged field remains an explicit server conflict with recoverable input', () => {
 const base = original(), next = structuredClone(base); next.cards[0].origin = 'Min ändring';
 const confirmed = confirm(base); confirmed.cards[0].origin = 'Annan ändring';
 const rebased = rebaseConfirmedChanges(base, next, confirmed);
 assert.equal(rebased.base.cards[0].origin, 'Gård 1'); assert.equal(rebased.next.cards[0].origin, 'Min ändring'); assert.equal(rebased.next.cards[0].customerApproval.id, 'review');
 assert.throws(() => mergeRecord(confirmed.cards[0], rebased.base.cards[0], rebased.next.cards[0]), /ändrades i en annan session/);
});

test('chained pending changes retain earlier input and local record additions/removals', () => {
 const base = original(), first = structuredClone(base); first.cards[0].origin = 'Ny adress';
 const second = structuredClone(first); second.cards[0].reference = 'Ny referens'; second.customers = [{ id: 'c2', name: 'Ny kund' }];
 const initial = rebaseConfirmedChanges(base, first, confirm(base));
 const following = rebaseConfirmedChanges(first, second, initial.next);
 assert.equal(following.next.cards[0].origin, 'Ny adress'); assert.equal(following.next.cards[0].reference, 'Ny referens'); assert.equal(following.next.cards[0].status, 'customer');
 assert.deepEqual(following.next.customers, [{ id: 'c2', name: 'Ny kund' }]);
 assert.equal(following.base.cards[0].origin, 'Ny adress');
});
