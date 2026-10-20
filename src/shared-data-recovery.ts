/** Browser recovery is scoped to a durable principal, while request generations
 * remain short lived. This storage is an aid, never an authorization boundary. */
export type PendingBusinessChange<T> = { base: T; next: T };
type RecoverySource = { key: string; raw?: string; writeId?: string };
export type RecoveryDescriptor = {
  key: string;
  identity: string;
  branch(key: string): boolean;
  legacy(key: string): boolean;
  legacyOwnerKnown: boolean;
};
export type RecoveryState<T> = {
  queue: PendingBusinessChange<T>[];
  sources: RecoverySource[];
  blocked?: string;
};
type RecoveryEnvelope<T> = {
  version: 1;
  identity: string;
  writeId: string;
  queue: PendingBusinessChange<T>[];
  sources: RecoverySource[];
};
type BrowserStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
const invalidRecovery = 'Osända ändringar finns på enheten men kunde inte läsas säkert. Kontakta administratören innan du ändrar fler uppgifter.';
const storageUnavailable = 'Serverns uppgifter visas, men lokal återhämtning är inte tillgänglig. Kontrollera webbläsarens lagring innan du gör nya ändringar.';
const competingRecovery = 'Flera tidigare köer med osända ändringar behöver granskas. De finns kvar på enheten. Kontakta administratören innan du ändrar fler uppgifter.';

function storage(): BrowserStorage { return localStorage; }
export function newRecoveryId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues also works on local-network HTTP demos where browsers do
  // not expose randomUUID. These IDs identify writers; they are not auth tokens.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function pending<T>(value: unknown, parse: (value: unknown) => T): PendingBusinessChange<T>[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid recovery queue');
  return value.map(item => {
    if (!item || typeof item !== 'object' || !('base' in item) || !('next' in item)) throw new TypeError('Invalid recovery item');
    return { base: parse(item.base), next: parse(item.next) };
  });
}

/** Every write gets a fresh immutable ID. Other tabs can acknowledge this exact
 * snapshot without copying entire nested envelopes or claiming later work. */
export function saveBusinessRecovery<T>(descriptor: RecoveryDescriptor, state: Pick<RecoveryState<T>, 'queue' | 'sources'>): void {
  const envelope: RecoveryEnvelope<T> = { version: 1, identity: descriptor.identity, writeId: newRecoveryId(), queue: state.queue, sources: state.sources };
  storage().setItem(descriptor.key, JSON.stringify(envelope));
}

export function readBusinessRecovery<T>(descriptor: RecoveryDescriptor, parse: (value: unknown) => T): RecoveryState<T> {
  let store: BrowserStorage;
  try { store = storage(); } catch { return { queue: [], sources: [], blocked: storageUnavailable }; }
  try {
    const branches: Array<RecoverySource & RecoveryState<T>> = [], legacy: Array<{ key: string; raw: string }> = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (!key || !descriptor.legacy(key) && !descriptor.branch(key)) continue;
      const raw = store.getItem(key);
      if (raw === null) continue;
      if (descriptor.branch(key)) {
        const envelope = JSON.parse(raw) as Partial<RecoveryEnvelope<T>>;
        if (envelope?.version !== 1 || envelope.identity !== descriptor.identity || typeof envelope.writeId !== 'string'
          || !/^[a-f0-9-]{36}$/i.test(envelope.writeId) || !Array.isArray(envelope.sources)
          || envelope.sources.some(source => !source || typeof source.key !== 'string'
            || (descriptor.branch(source.key) ? typeof source.writeId !== 'string' || !/^[a-f0-9-]{36}$/i.test(source.writeId) || source.raw !== undefined
              : !descriptor.legacy(source.key) || typeof source.raw !== 'string' || source.writeId !== undefined)))
          return { queue: [], sources: [], blocked: invalidRecovery };
        branches.push({ key, writeId: envelope.writeId, queue: pending(envelope.queue, parse), sources: envelope.sources });
      } else if (pending(JSON.parse(raw), parse).length) legacy.push({ key, raw });
    }
    const copied = branches.flatMap(branch => branch.sources);
    const claimed = (source: RecoverySource) => copied.some(copy => copy.key === source.key
      && (source.writeId !== undefined ? copy.writeId === source.writeId : copy.raw === source.raw));
    const legacyCandidates = legacy.filter(source => !claimed(source));
    const branchCandidates = branches.filter(branch => branch.queue.length && !claimed(branch));
    const own = branches.find(branch => branch.key === descriptor.key);
    const current = own ? { queue: own.queue, sources: own.sources } : { queue: [], sources: [] };
    if (legacyCandidates.length && !descriptor.legacyOwnerKnown)
      return { ...current, blocked: 'Äldre osända administratörsändringar saknar säker ägarinformation. De finns kvar på enheten och behöver granskas av systemägaren.' };
    if (branchCandidates.length + legacyCandidates.length > 1)
      return { ...current, blocked: competingRecovery };
    const candidate = branchCandidates[0];
    if (candidate?.key === descriptor.key) return current;
    const legacySource = legacyCandidates[0];
    if (candidate || legacySource) {
      const result = { queue: candidate?.queue ?? pending(JSON.parse(legacySource.raw), parse),
        // Only the immediate source is needed: its own source claim remains
        // in that writer's envelope. Size grows linearly across repeated logins.
        sources: candidate ? [{ key: candidate.key, writeId: candidate.writeId! }] : [legacySource] };
      // Every hook/tab owns a unique writer branch. Neither a new login nor a
      // delayed ACK from another tab can overwrite this branch's pending work.
      // Foreign source branches are never deleted by this writer. An empty
      // acknowledgement marker recognizes the copied snapshot after success.
      saveBusinessRecovery(descriptor, result); return result;
    }
    return { queue: [], sources: own?.sources ?? [] };
  } catch (error) {
    return { queue: [], sources: [], blocked: error instanceof SyntaxError || error instanceof TypeError ? invalidRecovery : storageUnavailable };
  }
}

export function cleanAcknowledgedRecovery(descriptor: RecoveryDescriptor, state: Pick<RecoveryState<unknown>, 'queue' | 'sources'>): void {
  if (state.queue.length) return;
  try {
    const store = storage();
    // Ownership also applies to deletion. A getItem/compare/remove sequence is
    // not atomic across tabs: the source writer could append between the read
    // and removal. Only delete our own empty branch when it has no source
    // snapshots to acknowledge; otherwise retain its empty marker.
    if (!state.sources.length) store.removeItem(descriptor.key);
  } catch { /* The durable empty envelope still records acknowledgement. */ }
}
