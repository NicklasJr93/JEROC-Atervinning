import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

// Repositories have separate pools, but one business command must have only one
// commit. Scope includes connection identity/TLS/search_path, not pool sizing.
const units = new AsyncLocalStorage();
const diagnostics = new AsyncLocalStorage();
const scopes = new WeakMap();
const objectIds = new WeakMap();
let nextObjectId = 0;
const configurationKeys = ['connectionString', 'host', 'port', 'database', 'user', 'password', 'ssl', 'options', 'application_name', 'binary'];
function stable(value) {
  if (typeof value === 'function') {
    if (!objectIds.has(value)) objectIds.set(value, ++nextObjectId);
    return { functionIdentity: objectIds.get(value) };
  }
  if (Buffer.isBuffer(value)) return { buffer: value.toString('base64') };
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function scopeFor(pool) {
  if (!scopes.has(pool)) {
    if (!pool.options || typeof pool.options !== 'object') {
      // A custom pool with no declared config cannot safely share another pool's
      // client. The same pool still shares its own nested unit of work.
      scopes.set(pool, Symbol('database-pool'));
    } else {
      const config = Object.fromEntries(configurationKeys.filter(key => pool.options[key] !== undefined).map(key => [key, stable(pool.options[key])]));
      scopes.set(pool, Object.keys(config).length ? createHash('sha256').update(JSON.stringify(config)).digest('hex') : Symbol('database-pool'));
    }
  }
  return scopes.get(pool);
}

function markRollback(unit, error) {
  if (!unit.rollbackOnly) unit.failure = error;
  unit.rollbackOnly = true;
}
async function nested(unit, scope, readOnly, callback) {
  if (unit.state !== 'active') throw new Error('Databastransaktionen är redan avslutad.');
  if (unit.scope !== scope) {
    const error = new Error('En gemensam databastransaktion kan inte använda olika anslutningskonfigurationer.');
    markRollback(unit, error);
    throw error;
  }
  if (!readOnly && unit.readOnly) {
    const error = new Error('En skrivning kan inte startas i en lästransaktion.');
    markRollback(unit, error);
    throw error;
  }
  try { return await callback(unit.client); }
  catch (error) { markRollback(unit, error); throw error; }
}

async function invokeCommitted(callback) {
  try { await units.run(undefined, callback); }
  catch {
    // The durable command has already committed. A delivery/notification failure
    // must not make clients retry that command as though it had rolled back.
    process.emitWarning('En databasnotifiering efter commit misslyckades.', { code: 'JEROC_AFTER_COMMIT' });
  }
}

async function run(pool, callback, readOnly) {
  if (typeof callback !== 'function') throw new TypeError('Databasoperationen behöver en callback.');
  const scope = scopeFor(pool), current = units.getStore();
  if (current) return nested(current, scope, readOnly, callback);
  const metrics = diagnostics.getStore(), poolStarted = performance.now();
  const client = await pool.connect();
  if (metrics) metrics.poolWaitMs += performance.now() - poolStarted;
  const originalQuery = client.query;
  if (metrics) client.query = async function (...args) {
    const started = performance.now(), sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    metrics.sqlCount++;
    try { return await originalQuery.apply(this, args); }
    finally {
      const duration = performance.now() - started; metrics.sqlMs += duration;
      if (/FOR UPDATE|pg_advisory_xact_lock/i.test(sql)) metrics.lockQueryMs += duration;
      if (/^COMMIT\b/i.test(sql)) metrics.commitMs += duration;
    }
  };
  const unit = { scope, client, readOnly, state: 'active', rollbackOnly: false, failure: undefined, callbacks: [] };
  let result;
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    result = await units.run(unit, () => callback(client));
    if (unit.rollbackOnly) throw unit.failure;
    const committed = await client.query('COMMIT');
    if (committed?.command && committed.command !== 'COMMIT') throw new Error('Databastransaktionen återställdes innan den kunde slutföras.');
    unit.state = 'committed';
  } catch (error) {
    unit.state = 'rolled-back';
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (metrics) client.query = originalQuery; client.release(); }
  for (const callback of unit.callbacks) await invokeCommitted(callback);
  return result;
}

/** Same PostgreSQL configuration reuses the outer client and commit boundary. */
export const runInDatabaseTransaction = (pool, callback) => run(pool, callback, false);
/** A consistent, lock-free read snapshot; nested reads see the outer writes. */
export const runDatabaseRead = (pool, callback) => run(pool, callback, true);
/** Schedule non-transactional effects only after the outer durable commit. */
export function afterDatabaseCommit(callback) {
  if (typeof callback !== 'function') throw new TypeError('Databasnotifieringen behöver en callback.');
  const unit = units.getStore();
  if (!unit) return invokeCommitted(callback);
  if (unit.state !== 'active') throw new Error('Databastransaktionen är redan avslutad.');
  unit.callbacks.push(callback);
}

/** Timings contain only durations/counts, never SQL parameters or credentials.
 * Lock-query time includes its SQL round trip; it is not pure lock wait. */
export async function measureDatabaseWork(callback) {
  const metrics = { poolWaitMs: 0, sqlMs: 0, sqlCount: 0, lockQueryMs: 0, commitMs: 0 };
  const result = await diagnostics.run(metrics, callback);
  return { result, metrics };
}
