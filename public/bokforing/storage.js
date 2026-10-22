// Browser-local synthetic demo storage. Web Locks coordinate cooperating tabs;
// this is not a server ledger, an audit archive, or a security boundary.
import { STORAGE_KEY, createState, validateState } from './model.js';

export class DemoStorageError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DemoStorageError';
    this.code = code;
  }
}

const fail = (code, message, cause) => { throw new DemoStorageError(code, message, cause); };
const copy = value => structuredClone(value);
const revisionKnown = snapshot => snapshot && (snapshot.revision === null || typeof snapshot.revision === 'string');
const freshRevision = () => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    fail('COORDINATION_UNAVAILABLE', 'Webbläsaren kan inte skapa en säker demoversion. Bokföring är spärrad i den här webbläsaren.');
  }
  return globalThis.crypto.randomUUID();
};

/**
 * The stored JSON retains the legacy model format. Each successful write adds
 * a fresh metadata token to distinguish even reset -> identical seed (ABA).
 * Snapshot.revision is the exact observed JSON, including unknown metadata.
 * UI state must only be replaced after commit()/reset() resolves successfully.
 */
export function createDemoStorage({
  getStorage = () => globalThis.localStorage,
  locks = globalThis.navigator?.locks,
  key = STORAGE_KEY,
  makeRevision = freshRevision,
} = {}) {
  const lockName = `scrapplanner:bookkeeping-demo:${key}`;
  const coordinationAvailable = () => typeof locks?.request === 'function';

  function readRaw() {
    try {
      const storage = getStorage();
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new TypeError('Storage is unavailable');
      const raw = storage.getItem(key);
      if (raw !== null && typeof raw !== 'string') throw new TypeError('Storage returned an invalid value');
      return { storage, raw };
    } catch (error) {
      fail('READ_FAILED', 'Demolagringen kunde inte läsas. Inga ändringar görs. Läs in senaste demodata innan du försöker igen.', error);
    }
  }

  function decode(raw) {
    try {
      const value = raw === null ? createState() : JSON.parse(raw);
      validateState(value);
      return copy(value);
    } catch (error) {
      fail('INVALID_DATA', 'Sparade demodata kunde inte godkännas. De har bevarats. Läs in igen eller återställ demon uttryckligen.', error);
    }
  }

  function snapshot(state, revision, error = null) {
    return { state, revision, writable: !error && coordinationAvailable(), error };
  }

  function load() {
    let raw;
    try {
      ({ raw } = readRaw());
      const state = decode(raw);
      if (!coordinationAvailable()) {
        return snapshot(state, raw, new DemoStorageError('COORDINATION_UNAVAILABLE', 'Webbläsaren saknar stöd för samordning mellan flikar. Du kan läsa demon, men bokföring och återställning är spärrade.'));
      }
      return snapshot(state, raw);
    } catch (error) {
      // Keep the observed raw revision for an explicit reset. A read failure
      // leaves it undefined, so it can never masquerade as a fresh empty book.
      return snapshot(createState(), raw, error);
    }
  }

  async function write(expected, transition, resetting) {
    if (!coordinationAvailable()) {
      fail('COORDINATION_UNAVAILABLE', 'Webbläsaren saknar stöd för samordning mellan flikar. Bokföring och återställning är spärrade.');
    }
    if (!revisionKnown(expected)) {
      fail('READ_FAILED', 'Demolagringens senaste version är okänd. Läs in senaste demodata innan du försöker igen.');
    }
    if (!resetting && expected.error) throw expected.error;
    if (typeof transition !== 'function') throw new TypeError('Demouppdateringen behöver en funktion.');

    let entered = false;
    try {
      return await locks.request(lockName, { mode: 'exclusive' }, async lock => {
        entered = true;
        if (!lock) fail('COORDINATION_UNAVAILABLE', 'Demolagringen kunde inte låsas. Ingen bokföring genomfördes.');
        const { storage, raw } = readRaw();
        if (raw !== expected.revision) {
          fail('STALE_STATE', 'Demodata har ändrats i en annan flik. Din ändring har inte sparats. Läs in senaste demodata och granska underlaget igen.');
        }
        const current = resetting ? createState() : decode(raw);
        const next = await transition(copy(current));
        try { validateState(next); }
        catch (error) { fail('INVALID_DATA', 'Den nya demobokföringen kunde inte godkännas. Ingen ändring har sparats.', error); }
        const token = makeRevision();
        let previousToken;
        try { previousToken = raw === null ? undefined : JSON.parse(raw)?._demoStorageRevision; }
        catch { /* Explicit reset is also allowed for malformed stored JSON. */ }
        if (typeof token !== 'string' || !token.length || token === previousToken) {
          fail('COORDINATION_UNAVAILABLE', 'En ny demoversion kunde inte skapas. Ingen ändring har sparats.');
        }
        const storedState = { ...copy(next), _demoStorageRevision: token };
        const serialized = JSON.stringify(storedState);
        // A transition may yield. Reject an intervening non-cooperating change
        // before writing, while still holding the lock for cooperating tabs.
        if (readRaw().raw !== raw) {
          fail('STALE_STATE', 'Demodata har ändrats. Din ändring har inte sparats. Läs in senaste demodata och försök igen.');
        }
        try { storage.setItem(key, serialized); }
        catch (error) {
          fail('WRITE_FAILED', 'Demodata kunde inte sparas. Ingen bokföring eller återställning har bekräftats. Frigör lagringsutrymme eller kontrollera webbläsarens inställningar och läs in igen.', error);
        }
        let confirmed;
        try { confirmed = readRaw().raw; }
        catch (error) {
          fail('CONFIRM_FAILED', 'Sparandet kunde inte bekräftas. Läs in senaste demodata innan du försöker igen; ändringen kan redan vara sparad.', error);
        }
        if (confirmed !== serialized) {
          fail('CONFIRM_FAILED', 'Sparandet kunde inte bekräftas. Läs in senaste demodata innan du försöker igen; ingen ny bokföring ska antas vara sparad.');
        }
        return snapshot(copy(storedState), serialized);
      });
    } catch (error) {
      if (entered || error instanceof DemoStorageError) throw error;
      fail('COORDINATION_UNAVAILABLE', 'Webbläsaren kunde inte samordna sparandet. Ingen bokföring har bekräftats. Läs in senaste demodata och försök igen.', error);
    }
  }

  return {
    load,
    commit: (expected, transition) => write(expected, transition, false),
    reset: expected => write(expected, () => createState(), true),
  };
}
