import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const CHANGE_EVENT_CHANNEL = 'jeroc_changes';
const hubs = new Map();
export const makeChangeEvent = input => {
  if (!input || typeof input.domain !== 'string' || !/^[a-z][a-z0-9_-]{0,40}$/.test(input.domain)
    || !Number.isSafeInteger(input.revision) || input.revision < 0
    || (input.eventId !== undefined && (typeof input.eventId !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(input.eventId)))) throw new TypeError('Invalid change notification');
  return { domain: input.domain, revision: input.revision, eventId: input.eventId ?? randomUUID() };
};

/** Notifications are invalidations only. Never include a customer, source record,
 * credentials or document bytes. Consumers obtain a newly authorised projection. */
export function createChangeEvents({ env = process.env, namespace } = {}) {
  const key = namespace ?? createHash('sha256').update(env.DATABASE_URL ?? env.JEROC_APPLICATION_DB_PATH ?? 'jeroc-local-default').digest('hex');
  let hub = hubs.get(key);
  if (!hub) {
    const emitter = new EventEmitter(); emitter.setMaxListeners(0);
    const seen = new Set(); let pool, listener, connecting, timer, stopped = false;
    const accept = input => {
      let event; try { event = makeChangeEvent(input); } catch { return; }
      if (seen.has(event.eventId)) return;
      seen.add(event.eventId); if (seen.size > 1024) seen.delete(seen.values().next().value);
      // A subscriber error cannot make an already committed command look as
      // though it failed, or prevent another authorized stream from updating.
      for (const callback of emitter.listeners('change')) { try { callback(event); } catch {} }
    };
    const retry = milliseconds => { if (!stopped) { timer = setTimeout(() => void connect(), milliseconds); timer.unref(); } };
    const connect = () => {
      if (!env.DATABASE_URL || stopped || listener) return Promise.resolve();
      if (connecting) return connecting;
      connecting = (async () => {
        let client;
        try {
          if (!pool) { const { Pool } = await import('pg'); pool = new Pool({ connectionString: env.DATABASE_URL, max: 2, connectionTimeoutMillis: 8000 }); }
          client = await pool.connect();
          if (stopped) { client.release(); client=undefined; return; }
          const connected = client;
          const lost = () => {
            if (listener !== connected) return;
            listener = undefined; connected.release(true); retry(1000);
          };
          connected.on('error', lost); connected.on('end', lost);
          connected.on('notification', message => {
            if (message.channel === CHANGE_EVENT_CHANNEL) { try { accept(JSON.parse(message.payload)); } catch {} }
          });
          await connected.query(`LISTEN ${CHANGE_EVENT_CHANNEL}`);
          if (stopped) { connected.release(true); client=undefined; return; }
          listener = connected; client = undefined;
        } catch { if (client) client.release(true); retry(3000); }
        finally { connecting = undefined; }
      })();
      return connecting;
    };
    const publishLocal = input => { const event=makeChangeEvent(input); accept(event); return event; };
    hub = { references: 0, emitter, publishLocal, ready: connect,
      async publish(input) {
        const event=publishLocal(input);
        if (env.DATABASE_URL) { await connect(); if (pool) { try { await pool.query('SELECT pg_notify($1,$2)', [CHANGE_EVENT_CHANNEL,JSON.stringify(event)]); } catch {} } }
        return event;
      },
      async stop() {
        stopped=true; clearTimeout(timer);
        if (listener) { const connected=listener; listener=undefined; connected.release(true); }
        if (connecting) await connecting;
        if (pool) await pool.end();
      },
    };
    hubs.set(key,hub);
  }
  hub.references++;
  let released=false;
  return { ready:()=>hub.ready(), publishLocal:input=>hub.publishLocal(input), publish:input=>hub.publish(input),
    subscribe(callback) { hub.emitter.on('change',callback); void hub.ready(); return ()=>hub.emitter.off('change',callback); },
    async close() { if (released) return; released=true; if (--hub.references===0) { hubs.delete(key); await hub.stop(); } },
  };
}

export const getChangeEvents = env => createChangeEvents({env});
