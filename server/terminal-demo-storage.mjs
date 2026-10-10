import { mkdir, chmod, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runInDatabaseTransaction, runDatabaseRead, afterDatabaseCommit } from './database-runtime.mjs';
import { getChangeEvents, makeChangeEvent, CHANGE_EVENT_CHANNEL } from './change-events.mjs';

export class TerminalDemoError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}

export const TERMINAL_WEIGHING_DEMO_VERSION = 'demo-weighings-2026-10-09-v2';

/** Explicit, one-time removal of obsolete demo weighing data, not accounts. */
export function migrateTerminalDemoWeighings(state) {
  if (state.weighingDemoVersion === TERMINAL_WEIGHING_DEMO_VERSION) return false;
  const removedApprovals = state.approvals?.length ?? 0;
  state.approvals = [];
  state.requests = [];
  // Reservation is derived from active approvals, so clearing them releases the
  // display without invalidating the device cookie or the terminal password.
  state.audit = (state.audit ?? []).filter((entry) =>
    !entry.approvalId && entry.cardId == null && !entry.action?.startsWith('approval.'));
  state.weighingDemoVersion = TERMINAL_WEIGHING_DEMO_VERSION;
  state.revision = (state.revision ?? 0) + 1;
  state.audit.push({ id: TERMINAL_WEIGHING_DEMO_VERSION, at: new Date().toISOString(),
    action: 'demo.weighings_reset', removedApprovals,
    reason: 'Testinvägningar ersatta på uttrycklig begäran; terminalkonton och inställningar bevarade.' });
  return true;
}

export const initialTerminalState = () => ({
  schemaVersion: 1, revision: 0, weighingDemoVersion: TERMINAL_WEIGHING_DEMO_VERSION,
  terminals: [], terminalSessions: [], staffSessions: [],
  defaults: [], approvals: [], requests: [], audit: [], loginAttempts: [],
});


const sqliteQueues = new Map();
const hasDocumentSnapshot = approval => {
  const snapshot=approval?.snapshot;
  return typeof approval?.id==='string' && Boolean(approval.id) && Number.isSafeInteger(approval.cardId)
    && typeof approval.siteId==='string' && /^[a-f0-9]{64}$/.test(snapshot?.hash??'')
    && snapshot?.card?.id===approval.cardId && Boolean(snapshot?.customer?.id && snapshot.customer.name)
    && Array.isArray(snapshot?.rows) && snapshot.rows.length>0
    && snapshot.rows.every(row=>row && typeof row.name==='string' && typeof row.articleId==='string'
      && Number.isFinite(row.weight) && row.weight>0 && Number.isFinite(row.price) && row.price>=0 && Number.isFinite(row.amount))
    && ['gross','offset','net'].every(key=>Number.isFinite(snapshot[key]))
    && Number.isFinite(Date.parse(approval.createdAt));
};
const validApproval = approval => approval.approvedHash === approval.snapshot?.hash && approval.approvedAt && approval.approvedMethod;
const stages = approval => ['preliminary', ...(['approved','attested'].includes(approval.status) && validApproval(approval) ? ['reviewed'] : []), ...(approval.status === 'attested' && validApproval(approval) && approval.attestedAt ? ['final'] : [])];
const jobsFor = (state, before) => {
  const previous=new Map((before?.approvals??[]).map(approval=>[approval.id,approval]));
  return state.approvals.flatMap(approval => {
  // Legacy/demo placeholders remain preserved, but cannot create a fabricated
  // PDF original or prevent unrelated terminal/account work from committing.
  if(!hasDocumentSnapshot(approval))return [];
  const old = previous.get(approval.id);
  const existingStages = new Set(old ? stages(old) : []);
  return stages(approval).filter(stage => !existingStages.has(stage)).map(stage => ({ id: createHash('sha256').update(`${approval.id}:${stage}:${approval.snapshot.hash}`).digest('hex'), approvalId: approval.id, stage, sourceHash: approval.snapshot.hash, approval: structuredClone(approval), createdAt: approval.updatedAt ?? approval.createdAt ?? new Date().toISOString() }));
  });
};
const overlay = (value, presence) => {
  const state = { ...initialTerminalState(), ...value };
  // A missing migration marker is meaningful; projection defaults must never
  // make an explicitly requested legacy reset appear already applied.
  if(!Object.hasOwn(value,'weighingDemoVersion'))delete state.weighingDemoVersion;
  const seen = new Map(presence.map(row => [row.terminal_id, typeof row.seen_at === 'string' ? row.seen_at : row.seen_at.toISOString()]));
  state.terminals = state.terminals.map(terminal => seen.has(terminal.id) && (!terminal.lastSeen || seen.get(terminal.id) > terminal.lastSeen) ? { ...terminal, lastSeen: seen.get(terminal.id) } : terminal);
  return state;
};

/** The aggregate is locked only for commands. Presence and durable PDF jobs are
 * separate rows; state/session projections never rewrite the aggregate. */
export async function createTerminalDemoRepository({ env = process.env, filename } = {}) {
  if (!env.DATABASE_URL && env.RENDER) throw new TerminalDemoError('Kundterminaler behöver en PostgreSQL-databas. Lägg till DATABASE_URL i Render.',503,'setup_required');
  const events = getChangeEvents(env);
  const migration = await readFile(new URL('./migrations/terminal-demo-002.sql',import.meta.url),'utf8');
  if (env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({connectionString:env.DATABASE_URL,max:5,connectionTimeoutMillis:8000});
    const insertJobs = async (client,state,before) => {
      for (const job of jobsFor(state,before)) await client.query('INSERT INTO jeroc_terminal_pdf_jobs(id,approval_id,stage,source_hash,approval_snapshot,created_at,available_at) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(id) DO NOTHING',[job.id,job.approvalId,job.stage,job.sourceHash,JSON.stringify(job.approval),job.createdAt]);
    };
    try {
      await runInDatabaseTransaction(pool,async client => {
        await client.query('SELECT pg_advisory_xact_lock(1803299854)');
        await client.query(await readFile(new URL('./migrations/terminal-demo-001.sql',import.meta.url),'utf8'));
        await client.query(migration);
        await client.query('INSERT INTO jeroc_terminal_demo(id,state) VALUES(1,$1) ON CONFLICT(id) DO NOTHING',[JSON.stringify(initialTerminalState())]);
        const {rows} = await client.query('SELECT state FROM jeroc_terminal_demo WHERE id=1 FOR UPDATE');
        const state=rows[0].state;
        if (migrateTerminalDemoWeighings(state)) await client.query('UPDATE jeroc_terminal_demo SET state=$1,updated_at=NOW() WHERE id=1',[JSON.stringify(state)]);
        await insertJobs(client,state);
      });
    } catch(error) { await pool.end(); await events.close(); throw error; }
    const readState = async (client,options={}) => {
      let query='SELECT state FROM jeroc_terminal_demo WHERE id=1',parameters=[];
      if (options.deviceHash) {
        query=`SELECT jsonb_build_object('revision',state->'revision','terminalSessions',COALESCE((SELECT jsonb_agg(s) FROM jsonb_array_elements(state->'terminalSessions') s WHERE s->>'tokenHash'=$1),'[]'::jsonb),'terminals',COALESCE((SELECT jsonb_agg(t) FROM jsonb_array_elements(state->'terminals') t WHERE t->>'id' IN (SELECT s->>'terminalId' FROM jsonb_array_elements(state->'terminalSessions') s WHERE s->>'tokenHash'=$1)),'[]'::jsonb),'approvals',COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(state->'approvals') a WHERE a->>'status' IN ('waiting','id_requested') AND a->>'terminalId' IN (SELECT s->>'terminalId' FROM jsonb_array_elements(state->'terminalSessions') s WHERE s->>'tokenHash'=$1)),'[]'::jsonb)) AS state FROM jeroc_terminal_demo WHERE id=1`;
        parameters=[options.deviceHash];
      } else if (options.staffState) {
        query="SELECT jsonb_build_object('revision',state->'revision','staffSessions',COALESCE((SELECT jsonb_agg(s) FROM jsonb_array_elements(state->'staffSessions') s WHERE s->>'tokenHash'=$1),'[]'::jsonb),'terminalSessions',state->'terminalSessions','terminals',COALESCE((SELECT jsonb_agg(t) FROM jsonb_array_elements(state->'terminals') t WHERE $2::text IS NULL OR t->>'siteId'=$2),'[]'::jsonb),'defaults',state->'defaults','approvals',COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(state->'approvals') a WHERE $2::text IS NULL OR a->>'siteId'=$2),'[]'::jsonb)) AS state FROM jeroc_terminal_demo WHERE id=1";
        parameters=[options.staffHash,options.siteId??null];
      } else if (options.maintenance) {
        query="SELECT jsonb_build_object('revision',state->'revision','terminals',state->'terminals','terminalSessions',state->'terminalSessions','approvals',COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(state->'approvals') a WHERE a->>'status' IN ('waiting','id_requested')),'[]'::jsonb)) AS state FROM jeroc_terminal_demo WHERE id=1";
      } else if (options.staffHash) {
        query="SELECT jsonb_build_object('revision',state->'revision','staffSessions',COALESCE((SELECT jsonb_agg(s) FROM jsonb_array_elements(state->'staffSessions') s WHERE s->>'tokenHash'=$1),'[]'::jsonb)) AS state FROM jeroc_terminal_demo WHERE id=1"; parameters=[options.staffHash];
      } else if (options.cardId !== undefined) {
        query="SELECT jsonb_build_object('revision',state->'revision','terminals',state->'terminals','terminalSessions',state->'terminalSessions','approvals',COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(state->'approvals') a WHERE a->>'cardId'=$1),'[]'::jsonb)) AS state FROM jeroc_terminal_demo WHERE id=1"; parameters=[String(options.cardId)];
      } else if (options.projections) query="SELECT jsonb_build_object('revision',state->'revision','approvals',state->'approvals','terminals',state->'terminals','terminalSessions',state->'terminalSessions') AS state FROM jeroc_terminal_demo WHERE id=1";
      query=query.replace('SELECT state FROM','SELECT state AS state FROM').replace(' AS state FROM'," AS state,COALESCE((SELECT jsonb_agg(jsonb_build_object('terminal_id',terminal_id,'seen_at',seen_at)) FROM jeroc_terminal_presence),'[]'::jsonb) AS presence FROM");
      const {rows}=await client.query(query,parameters);
      return overlay(rows[0].state,rows[0].presence);
    };
    let closed=false;
    return {
      kind:'postgresql',events,
      read: (callback,options) => runDatabaseRead(pool,async client=>callback(await readState(client,options))),
      transact: callback => runInDatabaseTransaction(pool,async client => {
        const {rows}=await client.query('SELECT state FROM jeroc_terminal_demo WHERE id=1 FOR UPDATE');
        const original=rows[0].state,before=structuredClone(original),state=overlay(original,(await client.query('SELECT terminal_id,seen_at FROM jeroc_terminal_presence')).rows);
        const aggregateBefore=structuredClone(state);
        migrateTerminalDemoWeighings(state);
        const result=await callback(state);
        if (!isDeepStrictEqual(state,aggregateBefore)) {
          const notification=makeChangeEvent({domain:'terminal',revision:state.revision});
          await client.query('UPDATE jeroc_terminal_demo SET state=$1,updated_at=NOW() WHERE id=1 RETURNING pg_notify($2,$3)',[JSON.stringify(state),CHANGE_EVENT_CHANNEL,JSON.stringify(notification)]);
          await insertJobs(client,state,before);
          afterDatabaseCommit(()=>events.publishLocal(notification));
        }
        return result;
      }),
      async touchPresence(terminalId,at) { const changed=await runInDatabaseTransaction(pool,async client=>{const previous=(await client.query('SELECT seen_at FROM jeroc_terminal_presence WHERE terminal_id=$1',[terminalId])).rows[0];const old=previous?new Date(previous.seen_at).getTime():0; if (Date.parse(at)-old<10000)return false; const notification=Date.parse(at)-old>=35000?makeChangeEvent({domain:'terminal-presence',revision:Date.parse(at)}):undefined; await client.query('INSERT INTO jeroc_terminal_presence(terminal_id,seen_at) VALUES($1,$2) ON CONFLICT(terminal_id) DO UPDATE SET seen_at=GREATEST(jeroc_terminal_presence.seen_at,EXCLUDED.seen_at) RETURNING CASE WHEN $3::text IS NOT NULL THEN pg_notify($4,$3) END',[terminalId,at,notification?JSON.stringify(notification):null,CHANGE_EVENT_CHANNEL]);if(notification)afterDatabaseCommit(()=>events.publishLocal(notification));return true;});return changed; },
      async claimDocumentJob(at=new Date().toISOString(),leaseMs=60000) { return runInDatabaseTransaction(pool,async client=>{const claim=randomUUID(),until=new Date(Date.parse(at)+leaseMs).toISOString();const {rows}=await client.query("UPDATE jeroc_terminal_pdf_jobs SET status='running',claim_token=$1,lease_until=$2,attempts=attempts+1 WHERE id=(SELECT id FROM jeroc_terminal_pdf_jobs WHERE (status='pending' AND available_at<=$3) OR (status='running' AND lease_until<=$3) ORDER BY created_at,approval_id,CASE stage WHEN 'preliminary' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *",[claim,until,at]);const row=rows[0];return row?{id:row.id,stage:row.stage,sourceHash:row.source_hash,approval:row.approval_snapshot,siteSnapshot:row.approval_snapshot.siteSnapshot,claimToken:claim,attempts:row.attempts}:undefined;}); },
      async finishDocumentJob(job,error,at=new Date().toISOString()) { return runInDatabaseTransaction(pool,client=>client.query("UPDATE jeroc_terminal_pdf_jobs SET status=$1,available_at=$2,lease_until=NULL,claim_token=NULL,last_error=$3,completed_at=$4 WHERE id=$5 AND status='running' AND claim_token=$6",[error?'pending':'completed',new Date(Date.parse(at)+(error?Math.min(60000,1000*2**Math.min(job.attempts,6)):0)).toISOString(),error?'pdf_archival_retry':null,error?null:at,job.id,job.claimToken])); },
      async documentJobs() { return runDatabaseRead(pool,async client=>(await client.query('SELECT id,status,stage,attempts,approval_id FROM jeroc_terminal_pdf_jobs ORDER BY created_at,id')).rows); },
      async close(){if(closed)return;closed=true;await events.close();await pool.end();},
    };
  }
  const file=filename??env.JEROC_TERMINAL_DB_PATH??resolve(process.cwd(),'.data','terminal-demo.sqlite');
  if(file!==':memory:')await mkdir(dirname(file),{recursive:true,mode:0o700});
  const {DatabaseSync}=await import('node:sqlite');const database=new DatabaseSync(file);
  database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jeroc_terminal_demo(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL)');
  database.exec(migration.replaceAll('JSONB','TEXT').replaceAll('TIMESTAMPTZ','TEXT'));
  database.prepare('INSERT OR IGNORE INTO jeroc_terminal_demo(id,state) VALUES(1,?)').run(JSON.stringify(initialTerminalState()));
  const enqueue=(state,before)=>{for(const job of jobsFor(state,before))database.prepare('INSERT OR IGNORE INTO jeroc_terminal_pdf_jobs(id,approval_id,stage,source_hash,approval_snapshot,created_at,available_at) VALUES(?,?,?,?,?,?,?)').run(job.id,job.approvalId,job.stage,job.sourceHash,JSON.stringify(job.approval),job.createdAt,job.createdAt);};
  database.exec('BEGIN IMMEDIATE');try{const state=JSON.parse(database.prepare('SELECT state FROM jeroc_terminal_demo WHERE id=1').get().state);if(migrateTerminalDemoWeighings(state))database.prepare('UPDATE jeroc_terminal_demo SET state=? WHERE id=1').run(JSON.stringify(state));enqueue(state);database.exec('COMMIT');}catch(error){database.exec('ROLLBACK');throw error;}
  if(file!==':memory:')await chmod(file,0o600);
  const queueKey=file===':memory:'?Symbol('terminal-memory'):resolve(file);
  const queue=sqliteQueues.get(queueKey)??{tail:Promise.resolve(),references:0};queue.references++;sqliteQueues.set(queueKey,queue);
  const serial=operation=>{const job=queue.tail.then(operation);queue.tail=job.catch(()=>{});return job;};
  const state=()=>overlay(JSON.parse(database.prepare('SELECT state FROM jeroc_terminal_demo WHERE id=1').get().state),database.prepare('SELECT terminal_id,seen_at FROM jeroc_terminal_presence').all());
  let closed=false;
  return {kind:'sqlite',events,
    async read(callback,options={}) {const value=state();if(options.deviceHash){value.terminalSessions=value.terminalSessions.filter(s=>s.tokenHash===options.deviceHash);const ids=new Set(value.terminalSessions.map(s=>s.terminalId));value.terminals=value.terminals.filter(t=>ids.has(t.id));value.approvals=value.approvals.filter(a=>ids.has(a.terminalId)&&['waiting','id_requested'].includes(a.status));}if(options.cardId!==undefined)value.approvals=value.approvals.filter(a=>a.cardId===options.cardId);if(options.staffHash)value.staffSessions=value.staffSessions.filter(s=>s.tokenHash===options.staffHash);return callback(value);},
    transact:callback=>serial(async()=>{database.exec('BEGIN IMMEDIATE');let notification;try{const value=state(),before=structuredClone(value);migrateTerminalDemoWeighings(value);const pending=callback(value),result=pending&&typeof pending.then==='function'?await pending:pending;if(!isDeepStrictEqual(value,before)){database.prepare('UPDATE jeroc_terminal_demo SET state=? WHERE id=1').run(JSON.stringify(value));enqueue(value,before);notification={domain:'terminal',revision:value.revision};}database.exec('COMMIT');if(notification)events.publishLocal(notification);return result;}catch(error){database.exec('ROLLBACK');throw error;}}),
    touchPresence:(terminalId,at)=>serial(async()=>{const old=database.prepare('SELECT seen_at FROM jeroc_terminal_presence WHERE terminal_id=?').get(terminalId)?.seen_at;if(old&&Date.parse(at)-Date.parse(old)<10000)return false;database.prepare('INSERT INTO jeroc_terminal_presence(terminal_id,seen_at) VALUES(?,?) ON CONFLICT(terminal_id) DO UPDATE SET seen_at=MAX(seen_at,excluded.seen_at)').run(terminalId,at);if(!old||Date.parse(at)-Date.parse(old)>=35000)events.publishLocal({domain:'terminal-presence',revision:Date.parse(at)});return true;}),
    claimDocumentJob:(at=new Date().toISOString(),leaseMs=60000)=>serial(()=>{database.exec('BEGIN IMMEDIATE');try{const row=database.prepare("SELECT * FROM jeroc_terminal_pdf_jobs WHERE (status='pending' AND available_at<=?) OR (status='running' AND lease_until<=?) ORDER BY created_at,approval_id,CASE stage WHEN 'preliminary' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,id LIMIT 1").get(at,at);if(!row){database.exec('COMMIT');return;}const claim=randomUUID();database.prepare("UPDATE jeroc_terminal_pdf_jobs SET status='running',claim_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(claim,new Date(Date.parse(at)+leaseMs).toISOString(),row.id);database.exec('COMMIT');return{id:row.id,stage:row.stage,sourceHash:row.source_hash,approval:JSON.parse(row.approval_snapshot),siteSnapshot:JSON.parse(row.approval_snapshot).siteSnapshot,claimToken:claim,attempts:row.attempts+1};}catch(error){database.exec('ROLLBACK');throw error;}}),
    finishDocumentJob:(job,error,at=new Date().toISOString())=>serial(()=>database.prepare("UPDATE jeroc_terminal_pdf_jobs SET status=?,available_at=?,lease_until=NULL,claim_token=NULL,last_error=?,completed_at=? WHERE id=? AND status='running' AND claim_token=?").run(error?'pending':'completed',new Date(Date.parse(at)+(error?Math.min(60000,1000*2**Math.min(job.attempts,6)):0)).toISOString(),error?'pdf_archival_retry':null,error?null:at,job.id,job.claimToken)),
    async documentJobs(){return database.prepare('SELECT id,status,stage,attempts,approval_id FROM jeroc_terminal_pdf_jobs ORDER BY created_at,id').all();},
    async close(){if(closed)return;closed=true;await queue.tail;database.close();if(--queue.references===0)sqliteQueues.delete(queueKey);await events.close();},
  };
}
