import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Execute the actual hook with a deterministic hook scheduler and synthetic
// browser APIs. No HTTP server, database, credentials or real storage is used.
const bundle = await build({
  entryPoints: [new URL('../src/shared-data.ts', import.meta.url).pathname], bundle: true,
  platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'isolated-recovery-browser', setup(builder) {
    builder.onResolve({ filter: /^(react|\.\/data|\.\/platform\/session)$/ }, args => ({ path: args.path, namespace: 'recovery-fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'recovery-fixture' }, args => ({ contents: args.path === 'react' ? `
      export function useRef(value) { const h=globalThis.recoveryHooks,i=h.index++; return h.values[i]??(h.values[i]={current:value}); }
      export function useState(value) { const h=globalThis.recoveryHooks,i=h.index++; if(!(i in h.values))h.values[i]=typeof value==='function'?value():value; return [h.values[i],next=>{h.values[i]=typeof next==='function'?next(h.values[i]):next;}]; }
      export function useEffect(run,deps) { const h=globalThis.recoveryHooks,i=h.index++,old=h.values[i]; if(!old||deps.some((value,index)=>value!==old.deps[index]))h.effects.push(()=>{old?.cleanup?.();h.values[i]={deps,cleanup:run()};}); }
    ` : args.path === './data' ? `export const articleGroups=[]; export const updateArticleCatalog=()=>true; export const updateCustomerPriceCatalog=()=>{};`
      : `export const currentPlatformSession=()=>globalThis.recoverySession;` }));
  } }],
});
const { useSharedData, sharedBusinessCacheKey, sharedBusinessIdentity, sharedBusinessRecoveryKey } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
// A second module-level session models another tab: changing/logging in that
// tab must not update the first tab's in-memory generation fence.
const { useSharedData: useSecondTabSharedData } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text.replaceAll('globalThis.recoverySession', 'globalThis.recoverySecondSession')).toString('base64')}`);
const recoveryBundle = await build({ entryPoints: [new URL('../src/shared-data-recovery.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false });
const { cleanAcknowledgedRecovery, newRecoveryId } = await import(`data:text/javascript;base64,${Buffer.from(recoveryBundle.outputFiles[0].text).toString('base64')}`);
const principal = { actor: 'business-owner', user: 'business-user' };
const session = (generation = 'first', company = 'company-a', actor = 'platform-owner') => ({
  authenticated: true, organisationId: company, generation, csrfToken: 'synthetic-csrf',
  actor: { id: actor, platformAdmin: false },
});
const settle = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve)); };

async function fixture(run) {
  const names = ['window', 'document', 'navigator', 'localStorage', 'fetch', 'setInterval', 'clearInterval', 'recoveryHooks', 'recoverySession', 'recoverySecondSession'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const values = new Map(), mounted = [], requests = [];
  let readFailure = false, writeFailure = () => false;
  let server = { name: 'server-value' }, post = payload => ({ data: structuredClone(server = payload.next), revision: requests.length });
  const store = {
    get length() { if (readFailure) throw new DOMException('Denied', 'SecurityError'); return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { if (readFailure) throw new DOMException('Denied', 'SecurityError'); return values.get(key) ?? null; },
    setItem(key, value) { if (writeFailure(key)) throw new DOMException('Quota exceeded', 'QuotaExceededError'); values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.window = new EventTarget(); globalThis.document = new EventTarget();
  document.visibilityState = 'visible';
  globalThis.localStorage = store; globalThis.setInterval = () => 1; globalThis.clearInterval = () => {};
  globalThis.recoverySession = session();
  globalThis.recoverySecondSession = session('second-tab');
  globalThis.fetch = async (url, init) => {
    const payload = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method, payload, headers: init.headers });
    let result = init.method === 'POST' ? await post(payload) : { data: structuredClone(server), revision: requests.length };
    return { ok: !result.status || result.status < 400, status: result.status ?? 200, json: async () => result };
  };
  const mount = (identity = principal, domain = 'office', hook = useSharedData) => {
    const hooks = { index: 0, values: [], effects: [] }, accepted = [], errors = [];
    const current = { current: { name: 'initial' } };
    const options = { domain, key: 'fixture-data', identity, current, parse: value => structuredClone(value),
      accept: value => { accepted.push(structuredClone(value)); current.current = value; }, error: value => errors.push(value) };
    const instance = {
      current, accepted, errors,
      render() { globalThis.recoveryHooks = hooks; hooks.index = 0; const result = hook(options); for (const effect of hooks.effects.splice(0)) effect(); return result; },
      cleanup() { for (const value of hooks.values) value?.cleanup?.(); },
    };
    mounted.push(instance); instance.render(); return instance;
  };
  try {
    await run({ values, requests, mount, store,
      readFailure(value) { readFailure = value; }, writeFailure(value) { writeFailure = value; },
      server(value) { server = value; }, post(value) { post = value; },
    });
  } finally {
    for (const instance of mounted) instance.cleanup();
    for (const [name, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
}
const writes = fixture => fixture.requests.filter(request => request.method === 'POST');
const durableKey = identity => sharedBusinessRecoveryKey('fixture-data', 'office', identity ?? principal);
const envelopes = (fixture, identity) => [...fixture.values].filter(([key]) => key.startsWith(durableKey(identity))).map(([, value]) => JSON.parse(value));
const oldKey = identity => `${sharedBusinessCacheKey('fixture-data', identity)}.server-pending.${sharedBusinessIdentity(identity)}`;

test('a failed durable change resumes after login with a new generation and keeps its original base', () => fixture(async f => {
  f.post(() => ({ status: 503, error: 'Synthetic outage' }));
  const first = f.mount(); await settle();
  assert.equal(first.render().save({ name: 'unsent-value' }), true); await settle(); first.cleanup();
  assert.equal(envelopes(f).at(-1).queue.length, 1);
  globalThis.recoverySession = session('second');
  f.post(payload => { assert.deepEqual(payload.base, { name: 'server-value' }); return { data: payload.next, revision: 4 }; });
  const fresh = f.mount(); await settle();
  assert.equal(fresh.render().ready, true); assert.equal(fresh.current.current.name, 'unsent-value');
  assert.deepEqual(fresh.accepted[0], { name: 'server-value' });
  assert.equal(writes(f).length, 2); assert.equal(envelopes(f).at(-1).queue.length, 0);
}));

test('durable identities separate tenant, actual platform actor and effective account', () => fixture(async f => {
  const first = durableKey();
  globalThis.recoverySession = session('new-generation'); assert.equal(durableKey(), first);
  globalThis.recoverySession = session('new-generation', 'company-b'); assert.notEqual(durableKey(), first);
  globalThis.recoverySession = session('new-generation', 'company-a', 'another-platform-actor'); assert.notEqual(durableKey(), first);
  globalThis.recoverySession = session(); assert.notEqual(durableKey({ ...principal, user: 'another-effective-user' }), first);
  assert.equal(writes(f).length, 0);
}));

test('another tenant or actual actor cannot discover and replay an existing pending queue', () => fixture(async f => {
  f.post(() => ({ status: 503, error: 'Synthetic outage' }));
  const first = f.mount(); await settle(); first.render().save({ name: 'private-pending' }); await settle(); first.cleanup();
  const saved = [...f.values].find(([key]) => key.startsWith(durableKey()))[1];
  for (const changed of [session('second', 'company-b'), session('third', 'company-a', 'another-platform-actor')]) {
    globalThis.recoverySession = changed;
    const fresh = f.mount(); await settle();
    assert.equal(fresh.render().ready, true); assert.equal(fresh.current.current.name, 'server-value'); fresh.cleanup();
  }
  assert.equal(writes(f).length, 1); assert.ok([...f.values.values()].includes(saved));
}));

test('revoked permissions never expose a previous session snapshot before the server accepts it', () => fixture(async f => {
  f.server({ name: 'visible', secret: 'old-privileged-value' });
  f.post(() => ({ status: 503, error: 'Synthetic outage' }));
  const first = f.mount(); await settle(); first.render().save({ name: 'unsent-value', secret: 'old-privileged-value' }); await settle(); first.cleanup();
  globalThis.recoverySession = session('limited'); f.server({ name: 'visible' });
  f.post(() => ({ status: 403, error: 'Permission revoked' }));
  const limited = f.mount(); await settle();
  assert.equal(limited.render().ready, true); assert.deepEqual(limited.current.current, { name: 'visible' });
  assert.ok(limited.accepted.every(value => !('secret' in value)));
  assert.equal(limited.render().save({ name: 'replacement' }), false);
  assert.equal(envelopes(f).at(-1).queue.length, 1);
}));

test('a known-owner legacy generation queue is adopted once and acknowledged without deleting foreign bytes', () => fixture(async f => {
  const legacy = oldKey(principal), raw = JSON.stringify([{ base: { name: 'server-value' }, next: { name: 'legacy-unsent' } }]);
  f.values.set(legacy, raw); globalThis.recoverySession = session('second');
  let release; f.post(() => new Promise(resolve => { release = resolve; }));
  const fresh = f.mount(); await settle();
  assert.equal(fresh.current.current.name, 'server-value'); assert.equal(f.values.get(legacy), raw);
  assert.equal(envelopes(f).at(-1).queue[0].next.name, 'legacy-unsent');
  release({ data: { name: 'legacy-unsent' }, revision: 2 }); await settle();
  assert.equal(fresh.current.current.name, 'legacy-unsent'); assert.equal(f.values.get(legacy), raw);
  fresh.cleanup(); const again = f.mount(); await settle(); assert.equal(again.render().ready, true); assert.equal(writes(f).length, 1);
}));

test('ambiguous legacy administrator queues remain untouched and are not replayed', () => fixture(async f => {
  const admin = { actor: '__platform-admin', user: '__platform-admin' };
  globalThis.recoverySession = { ...session(), actor: { id: 'actual-admin', platformAdmin: true } };
  const legacy = oldKey(admin), raw = JSON.stringify([{ base: { name: 'server-value' }, next: { name: 'unknown-owner' } }]);
  f.values.set(legacy, raw); globalThis.recoverySession = { ...globalThis.recoverySession, generation: 'second' };
  const fresh = f.mount(admin); await settle();
  assert.equal(fresh.render().ready, true); assert.match(fresh.render().recoveryBlocked, /ägarinformation/);
  assert.equal(fresh.current.current.name, 'server-value'); assert.equal(fresh.render().save({ name: 'new' }), false);
  assert.equal(f.values.get(legacy), raw); assert.equal(writes(f).length, 0);
}));

test('multiple legacy branches are preserved without guessing their order', () => fixture(async f => {
  const raw = value => JSON.stringify([{ base: { name: 'server-value' }, next: { name: value } }]);
  const firstKey = oldKey(principal); f.values.set(firstKey, raw('first'));
  globalThis.recoverySession = session('second'); const secondKey = oldKey(principal); f.values.set(secondKey, raw('second'));
  globalThis.recoverySession = session('third'); const fresh = f.mount(); await settle();
  assert.match(fresh.render().recoveryBlocked, /Flera tidigare köer/); assert.equal(fresh.current.current.name, 'server-value');
  assert.equal(f.values.get(firstKey), raw('first')); assert.equal(f.values.get(secondKey), raw('second')); assert.equal(writes(f).length, 0);
}));

test('quota or inaccessible local storage does not block a successful server read, but rejects a non-durable write', () => fixture(async f => {
  f.writeFailure(() => true); const quota = f.mount(); await settle();
  assert.equal(quota.render().ready, true); assert.equal(quota.current.current.name, 'server-value');
  assert.equal(quota.render().save({ name: 'must-not-be-accepted' }), false); quota.cleanup();
  f.readFailure(true); const inaccessible = f.mount(); await settle();
  assert.equal(inaccessible.render().ready, true); assert.equal(inaccessible.current.current.name, 'server-value');
  assert.equal(inaccessible.render().save({ name: 'must-not-be-accepted' }), false); assert.equal(writes(f).length, 0);
}));

test('optional read-cache failure cannot reject a durably queued change', () => fixture(async f => {
  f.writeFailure(key => !key.includes('.recovery.v2.'));
  const app = f.mount(); await settle(); assert.equal(app.render().ready, true);
  assert.equal(app.render().save({ name: 'durable-change' }), true); await settle();
  assert.equal(app.current.current.name, 'durable-change'); assert.equal(writes(f).length, 1);
  assert.equal(envelopes(f).length, 0); assert.match(app.errors.at(-1), /läscachen/);
}));

test('a corrupt pending queue is preserved and does not hide current server data', () => fixture(async f => {
  const key = `${durableKey()}00000000-0000-0000-0000-000000000001`; f.values.set(key, '{malformed');
  const app = f.mount(); await settle();
  assert.equal(app.render().ready, true); assert.equal(app.current.current.name, 'server-value');
  assert.match(app.render().recoveryBlocked, /kunde inte läsas säkert/); assert.equal(app.render().save({ name: 'replace-corruption' }), false);
  assert.equal(f.values.get(key), '{malformed'); assert.equal(writes(f).length, 0);
}));

test('a stale flight cannot acknowledge or display data after a session generation changes', () => fixture(async f => {
  let release; f.post(() => new Promise(resolve => { release = resolve; }));
  const first = f.mount(); await settle(); first.render().save({ name: 'old-flight' }); await settle();
  globalThis.recoverySession = session('second');
  release({ data: { name: 'late-response' }, revision: 9 }); await settle();
  assert.ok(first.accepted.every(value => value.name !== 'late-response'));
  assert.equal(envelopes(f).at(-1).queue.length, 1);
}));

test('independent tabs never overwrite each others unsent changes or queue acknowledgements', () => fixture(async f => {
  const waiting = []; f.post(payload => new Promise(resolve => waiting.push({ payload, resolve })));
  const first = f.mount(), second = f.mount(principal, 'office', useSecondTabSharedData); await settle();
  first.render().save({ name: 'first-tab' }); await settle();
  second.render().save({ name: 'second-tab' }); await settle();
  assert.equal(envelopes(f).length, 2);
  assert.deepEqual(new Set(envelopes(f).map(envelope => envelope.queue[0].next.name)), new Set(['first-tab', 'second-tab']));
  waiting[0].resolve({ data: { name: 'first-tab' }, revision: 8 }); await settle();
  assert.equal(envelopes(f).length, 1); assert.equal(envelopes(f)[0].queue[0].next.name, 'second-tab');
  waiting[1].resolve({ status: 503, error: 'Still pending' }); await settle();
  first.cleanup(); second.cleanup(); globalThis.recoverySession = session('third');
  f.post(payload => ({ data: payload.next, revision: 20 }));
  const restored = f.mount(); await settle();
  assert.equal(restored.current.current.name, 'second-tab'); assert.equal(envelopes(f).at(-1).queue.length, 0);
}));

test('a delayed old-tab ACK cannot erase new work added after another login recovered the old change', () => fixture(async f => {
  const waiting = []; f.post(payload => new Promise(resolve => waiting.push({ payload, resolve })));
  const first = f.mount(); await settle(); first.render().save({ name: 'original-work' }); await settle();
  const second = f.mount(principal, 'office', useSecondTabSharedData); await settle();
  assert.equal(waiting.length, 2);
  waiting[1].resolve({ data: { name: 'original-work' }, revision: 8 }); await settle();
  assert.equal(second.current.current.name, 'original-work');
  second.render().save({ name: 'new-work-in-second-tab' }); await settle();
  waiting[0].resolve({ data: { name: 'original-work' }, revision: 7 }); await settle();
  assert.equal(envelopes(f).length, 1); assert.equal(envelopes(f)[0].queue[0].next.name, 'new-work-in-second-tab');
  waiting[2].resolve({ status: 503, error: 'Retain new work' }); await settle();
}));

test('recovery cleanup never deletes a source branch that acquired new work after it was copied', () => fixture(async f => {
  const waiting = []; f.post(payload => new Promise(resolve => waiting.push({ payload, resolve })));
  const first = f.mount(); await settle(); first.render().save({ name: 'copied-work' }); await settle();
  const second = f.mount(principal, 'office', useSecondTabSharedData); await settle();
  first.render().save({ name: 'additional-original-tab-work' }); await settle();
  waiting[1].resolve({ data: { name: 'copied-work' }, revision: 8 }); await settle();
  assert.equal(envelopes(f).find(envelope => envelope.queue.length).queue.at(-1).next.name, 'additional-original-tab-work');
  waiting[0].resolve({ status: 503, error: 'Preserve original branch' }); await settle();
}));

test('a recovered conflict archives its original baseline without overwriting a competing server edit', () => fixture(async f => {
  const legacy = oldKey(principal), item = { base: { name: 'original' }, next: { name: 'my-change' } };
  f.values.set(legacy, JSON.stringify([item])); globalThis.recoverySession = session('new-session');
  f.server({ name: 'competing-server-change' });
  f.post(payload => {
    if (payload.kind === 'update') { assert.deepEqual(payload.base, item.base); return { status: 409, error: 'Concurrent change' }; }
    assert.equal(payload.kind, 'archive'); assert.deepEqual(payload.data, item); return {};
  });
  const app = f.mount(); await settle();
  assert.equal(app.render().ready, true); assert.equal(app.current.current.name, 'competing-server-change');
  assert.match(app.errors.at(-1), /Samtidig ändring/); assert.equal(f.values.get(legacy), JSON.stringify([item]));
  assert.equal(envelopes(f).at(-1).queue.length, 0); assert.deepEqual(writes(f).map(request => request.payload.kind), ['update', 'archive']);
}));

test('acknowledgement cleanup never performs a non-atomic read and delete on a foreign source', () => fixture(async f => {
  const own = `${durableKey()}00000000-0000-0000-0000-000000000001`, foreign = `${durableKey()}00000000-0000-0000-0000-000000000002`;
  const old = 'copied-source-snapshot', updated = 'newly-appended-unsent-work';
  f.values.set(own, 'empty-acknowledgement-marker'); f.values.set(foreign, updated);
  const originalRead = f.store.getItem.bind(f.store);
  f.store.getItem = key => { if (key === foreign) { f.values.set(foreign, updated); return old; } return originalRead(key); };
  cleanAcknowledgedRecovery({ key: own }, { queue: [], sources: [{ key: foreign, writeId: '00000000-0000-0000-0000-000000000003' }] });
  assert.equal(f.values.get(foreign), updated); assert.equal(f.values.get(own), 'empty-acknowledgement-marker');
}));

test('repeated failed-login recovery uses compact source claims rather than recursively nested snapshots', () => fixture(async f => {
  f.post(() => ({ status: 503, error: 'Synthetic outage' }));
  let app = f.mount(); await settle(); app.render().save({ name: 'keep-until-server-confirms' }); await settle(); app.cleanup();
  const firstSize = JSON.stringify(envelopes(f)[0]).length;
  for (let login = 0; login < 12; login++) {
    globalThis.recoverySession = session(`relogin-${login}`);
    app = f.mount(); await settle();
    assert.equal(app.render().ready, true); app.cleanup();
  }
  const queues = envelopes(f);
  assert.equal(queues.length, 13);
  assert.ok(queues.every(envelope => JSON.stringify(envelope).length < firstSize * 3));
  assert.ok(queues.every(envelope => envelope.sources.length <= 1 && envelope.sources.every(source => source.raw === undefined)));
  assert.ok(queues.reduce((sum, envelope) => sum + JSON.stringify(envelope).length, 0) < firstSize * 3 * queues.length);
  f.post(payload => ({ data: payload.next, revision: 100 }));
  globalThis.recoverySession = session('successful-relogin'); app = f.mount(); await settle();
  assert.equal(app.current.current.name, 'keep-until-server-confirms'); app.cleanup();
  const attempts = writes(f).length;
  globalThis.recoverySession = session('after-ack'); app = f.mount(); await settle();
  assert.equal(app.render().ready, true); assert.equal(writes(f).length, attempts);
}));

test('local-network browsers without randomUUID can still allocate unique writer IDs', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let sequence = 0;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues(bytes) { bytes.fill(++sequence); return bytes; } } });
  try {
    const first = newRecoveryId(), second = newRecoveryId();
    assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    assert.notEqual(first, second);
  } finally { if (previous) Object.defineProperty(globalThis, 'crypto', previous); else delete globalThis.crypto; }
});
