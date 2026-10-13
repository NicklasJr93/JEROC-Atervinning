import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, CircleAlert, ExternalLink, LoaderCircle, Mail, Plus, RefreshCw, Save, Settings2, ShieldCheck, Unplug, X } from 'lucide-react';
import { can, type OfficeUser } from './model';
import { currentPlatformSession } from '../platform/session';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { environmentTime } from './environment-types';
import { clearIntegrationReadCache, integrationReadScope } from './integration-read-cache';
import { mailApi, mailIssueText, mayManageMail, type MailConnection, type MailMailbox, type MailState } from './mail-client';
import './mail-integration.css';

type MailboxForm = { id?: string; connectionId: string; address: string; displayName: string; enabled: boolean; allowedUserIds: string[] };
type Scoped<T> = { scope: string; value: T };
const formFrom = (mailbox: MailMailbox): MailboxForm => ({ id: mailbox.id, connectionId: mailbox.connectionId, address: mailbox.address,
  displayName: mailbox.displayName, enabled: mailbox.enabled, allowedUserIds: [...mailbox.allowedUserIds] });
const connected = (connection: MailConnection) => connection.status === 'connected';
const connectionLabel = (connection: MailConnection) => connected(connection) ? 'Ansluten' : connection.status === 'disconnected' ? 'Frånkopplad' : 'Behöver anslutas igen';
const safeMicrosoftUrl = (value: string) => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'login.microsoftonline.com' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};

function MicrosoftMark() { return <span className="mail-microsoft-mark" aria-hidden="true"><i /><i /><i /><i /></span>; }
function AccessChoices({ users, values, disabled, onChange }: { users: OfficeUser[]; values: string[]; disabled: boolean; onChange: (values: string[]) => void }) {
  const eligible = users.filter(person => person.active !== false && can(person, 'mailRead') && !mayManageMail(person, person));
  return <fieldset className="mail-access-choices" disabled={disabled}><legend>Vem får läsa inkorgen?</legend>
    <p>Personer med full integrationsbehörighet har åtkomst. Välj övriga personer som ska kunna läsa den här inkorgen.</p>
    {eligible.length ? <div className="mail-access-users">{eligible.map(person => <label key={person.id}><input type="checkbox" checked={values.includes(person.id)} onChange={event => onChange(event.target.checked ? [...new Set([...values, person.id])] : values.filter(id => id !== person.id))} /><span>{person.name}</span></label>)}</div>
      : <p>Ge medarbetare behörigheten Läsa mejl under Personal för att välja dem här.</p>}
  </fieldset>;
}

function DisconnectDialog({ connection, busy, onClose, onConfirm }: { connection: MailConnection; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); close.current?.focus(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="mail-disconnect-dialog" aria-labelledby="mail-disconnect-heading" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <button className="mail-dialog-close" type="button" aria-label="Stäng bekräftelsen" disabled={busy} onClick={onClose}><X size={19} /></button>
    <span className="mail-disconnect-icon"><Unplug size={25} /></span><h2 id="mail-disconnect-heading">Koppla bort mejlkontot?</h2>
    <p><strong>{connection.address}</strong></p><p>Synkningen stoppas för kontot och dess delade inkorgar. Du kan ansluta Microsoft-kontot igen senare. Inga mejl skickas eller raderas hos Microsoft.</p>
    <div className="mail-dialog-actions"><button ref={close} type="button" className="office-btn outline" disabled={busy} onClick={onClose}>Avbryt</button><button type="button" className="office-btn danger" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={15} className="mail-integration-spin" /> : <Unplug size={15} />}{busy ? 'Kopplar bort…' : 'Koppla bort konto'}</button></div>
  </dialog>;
}

export default function MailIntegrationPanel({ user, actualUser, users = [], onNotice }: {
  user: OfficeUser; actualUser: OfficeUser; users?: OfficeUser[]; onNotice: (message: string) => void;
}) {
  const { session, loading: sessionLoading, error: sessionError, refreshSession } = useEnvironmentSession();
  const [search] = useSearchParams();
  const permitted = mayManageMail(user, actualUser);
  const matchingSession = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const scope = integrationReadScope(actualUser, user, session);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const permittedRef = useRef(false);
  const mounted = useRef(true), epoch = useRef(0), mutationEpoch = useRef(0);
  const foreground = useRef<AbortController | undefined>(undefined), background = useRef<AbortController | undefined>(undefined);
  const [stored, setStored] = useState<Scoped<MailState>>(), [editor, setEditor] = useState<Scoped<MailboxForm>>();
  const [activity, setActivity] = useState<{ scope: string; pending?: string; error?: string; syncing?: string; syncError?: string; authFailed?: boolean }>();
  const [disconnecting, setDisconnecting] = useState<Scoped<MailConnection>>();
  const state = stored?.scope === scope ? stored.value : undefined, form = editor?.scope === scope ? editor.value : undefined;
  const currentActivity = activity?.scope === scope ? activity : undefined;
  const matching = matchingSession && !currentActivity?.authFailed;
  permittedRef.current = permitted && matching && !!scope;
  const confirmation = disconnecting?.scope === scope ? disconnecting.value : undefined;
  const editorArea = useRef<HTMLDivElement>(null);
  const patchActivity = (patch: Partial<NonNullable<typeof activity>>) => setActivity(previous => ({ ...(previous?.scope === scope ? previous : {}), scope, ...patch }));
  function accept(value: MailState) {
    const platform = currentPlatformSession();
    if (platform?.authenticated && value.organisationId !== platform.organisationId) throw new Error('Mejlanslutningen tillhör ett annat bolag. Uppdatera anslutningen.');
    setStored({ scope, value });
  }
  function apply(value: MailState) { accept(value); clearIntegrationReadCache('catalog'); }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; foreground.current?.abort(); background.current?.abort(); }; }, []);
  useEffect(() => { epoch.current++; foreground.current?.abort(); background.current?.abort(); foreground.current = undefined; background.current = undefined; setActivity({ scope }); }, [scope, permitted, matchingSession]);
  const run = useCallback(async (kind: string, operation: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (!permittedRef.current || foreground.current) return;
    const controller = new AbortController(), version = epoch.current; foreground.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && scopeRef.current === scope && integrationReadScope(actualUser, user, session) === scope && permittedRef.current && epoch.current === version && foreground.current === controller;
    patchActivity({ pending: kind, error: '' });
    try { await operation(controller.signal, current); }
    catch (failure) { if (current()) patchActivity({ error: environmentFailure(failure), authFailed: !!failure && typeof failure === 'object' && 'status' in failure && [401, 403].includes(Number(failure.status)) }); }
    finally { if (foreground.current === controller) { if (current()) patchActivity({ pending: undefined }); foreground.current = undefined; } }
  }, [scope]);
  const load = useCallback(() => run('load', async (signal, current) => { const value = await mailApi.state(signal); if (current()) accept(value); }), [run, scope]);
  useEffect(() => { if (permitted && matching) void load(); }, [permitted, matching, load]);
  useEffect(() => { if (form) editorArea.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' }); }, [form?.id, !!form]);

  function connectMicrosoft() { void run('connect', async (signal, current) => {
    const result = await mailApi.connectMicrosoft(signal);
    if (!current()) return;
    const destination = safeMicrosoftUrl(result.authorizationUrl);
    if (!destination) throw new Error('Microsofts inloggningsadress kunde inte verifieras. Försök ansluta kontot igen.');
    window.location.assign(destination);
  }); }
  function createMailbox() { setEditor({ scope, value: { connectionId: state?.connections.find(connected)?.id ?? '', address: '', displayName: '', enabled: true, allowedUserIds: [] } }); }
  function editMailbox(mailbox: MailMailbox) { setEditor({ scope, value: formFrom(mailbox) }); }
  function change(patch: Partial<MailboxForm>) { setEditor(previous => previous?.scope === scope ? { scope, value: { ...previous.value, ...patch } } : previous); }
  function saveMailbox(event: FormEvent) {
    event.preventDefault(); if (!form) return;
    const submitted = structuredClone(form); onNotice(''); mutationEpoch.current++;
    void run('mailbox', async (signal, current) => {
      const value = submitted.id ? await mailApi.updateMailbox(submitted.id, { displayName: submitted.displayName.trim() || submitted.address, enabled: submitted.enabled, allowedUserIds: submitted.allowedUserIds }, signal)
        : await mailApi.addMailbox({ connectionId: submitted.connectionId, address: submitted.address.trim(), displayName: submitted.displayName.trim() || undefined, allowedUserIds: submitted.allowedUserIds }, signal);
      if (!current()) return;
      apply(value); mutationEpoch.current++;
      setEditor(previous => previous?.scope === scope && previous.value.id === submitted.id ? undefined : previous);
      onNotice(submitted.id ? 'Inkorgens inställningar är sparade.' : 'Den delade inkorgen är tillagd. Synka för att hämta mejlen.');
    });
  }
  function disconnect() {
    if (!confirmation) return;
    const id = confirmation.id; mutationEpoch.current++; onNotice('');
    void run('disconnect', async (signal, current) => {
      const value = await mailApi.disconnect(id, signal);
      if (!current()) return;
      apply(value); mutationEpoch.current++; setDisconnecting(undefined);
      setEditor(previous => previous?.scope === scope && previous.value.connectionId === id ? undefined : previous);
      onNotice('Microsoft-kontot är bortkopplat. Synkningen har stoppats för dess inkorgar.');
    });
  }
  async function syncMailbox(mailboxId?: string) {
    if (!permittedRef.current || background.current) return;
    const controller = new AbortController(), version = epoch.current, beforeMutation = mutationEpoch.current; background.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && scopeRef.current === scope && integrationReadScope(actualUser, user, session) === scope && permittedRef.current && epoch.current === version && background.current === controller;
    patchActivity({ syncing: mailboxId ?? 'all', syncError: '' });
    try {
      let value = await mailApi.sync(mailboxId ? { mailboxId } : {}, controller.signal);
      if (!current()) return;
      if (beforeMutation !== mutationEpoch.current) value = await mailApi.state(controller.signal);
      if (current()) apply(value);
    } catch (failure) { if (current()) patchActivity({ syncError: environmentFailure(failure) }); }
    finally { if (background.current === controller) { if (current()) patchActivity({ syncing: undefined }); background.current = undefined; } }
  }
  async function retrySession() { await refreshSession(); if (scopeRef.current === scope && mounted.current) patchActivity({ authFailed: false, error: '' }); }

  if (!permitted) return <div className="office-panel integration-message"><ShieldCheck size={19} /><span>Du behöver behörighet att hantera bolagets integrationer för att ansluta och hantera inkorgar.</span></div>;
  if (!matching) return <div className="office-panel integration-message" role={sessionError || currentActivity?.error ? 'alert' : 'status'}><ShieldCheck size={19} /><span>{currentActivity?.authFailed ? currentActivity.error : sessionError || 'Hämtar bolagets mejlanslutning…'}</span>{!sessionLoading && <button className="office-btn outline" onClick={() => void retrySession().catch(() => undefined)}>Försök igen</button>}</div>;
  const pending = currentActivity?.pending, busy = !!pending, activeConnections = state?.connections.filter(connected) ?? [];
  const enabledMailboxes = state?.mailboxes.filter(mailbox => mailbox.enabled && activeConnections.some(connection => connection.id === mailbox.connectionId)) ?? [];
  const canManage = !!state?.capabilities.canManage;
  const formDisabled = !canManage || pending === 'mailbox' || pending === 'disconnect';
  const callback = search.get('mailAuth') ?? new URLSearchParams(window.location.search).get('mailAuth');
  return <section className="mail-integration-panel">
    <div className="mail-integration-heading"><div><h2>Konton och inkorgar</h2><p>Välj vilka brevlådor personalen får läsa.</p></div><button className="office-btn" disabled={!canManage || busy} onClick={createMailbox}><Plus size={16} />Lägg till inkorg</button></div>
    {callback && <div className={`mail-integration-feedback ${callback === 'ok' ? 'success' : 'warning'}`} role="status"><ShieldCheck size={17} /><span>{callback === 'ok' ? activeConnections.length ? 'Microsoft-kontot är anslutet. Inkorgarna visas nedan.' : state ? 'Ingen aktiv Microsoft-anslutning hittades. Försök ansluta kontot igen.' : 'Kontrollerar Microsoft-anslutningen…' : 'Microsoft-anslutningen kunde inte slutföras. Kontrollera uppgifterna nedan och försök igen.'}</span></div>}
    {currentActivity?.error && <div className="mail-integration-feedback error" role="alert"><CircleAlert size={17} /><span>{currentActivity.error}</span>{!busy && <button className="office-link" onClick={() => void load()}>Uppdatera anslutning</button>}</div>}
    {!state && <div className="office-panel mail-integration-feedback" role="status">{busy && <LoaderCircle size={17} className="mail-integration-spin" />}<span>{busy ? 'Hämtar bolagets inkorgar…' : 'Inkorgarna kunde inte hämtas.'}</span>{!busy && <button className="office-btn outline" onClick={() => void load()}>Försök igen</button>}</div>}
    {state && <>
      {!state.configuration.ready && <div className="office-panel mail-integration-setup"><ShieldCheck size={18} /><div><h3>Förbered Microsoft-anslutningen på servern</h3><p>Lägg in följande inställningar i Render → Environment. Kontoanslutningen görs sedan här med Microsofts egen inloggning.</p><ul>{[...state.configuration.missing, ...state.configuration.issues].map((item, index) => <li key={`${index}/${item}`}><code>{mailIssueText(item)}</code></li>)}</ul>{state.configuration.redirectUri && <><p>Registrera denna exakta returadress i Microsoft Entra:</p><code className="mail-redirect-uri">{state.configuration.redirectUri}</code></>}</div></div>}
      <div className="mail-provider-grid"><article className="office-panel mail-provider-card microsoft"><MicrosoftMark /><div><div className="mail-provider-heading"><h3>Microsoft 365 / Outlook</h3><span className={`mail-connection-status ${activeConnections.length ? 'connected' : 'muted'}`}>{activeConnections.length ? 'Ansluten' : 'Inte ansluten'}</span></div><p>Anslut med ditt Microsoft-konto. Flera konton och delade inkorgar kan kopplas till bolaget.</p><div className="mail-provider-footer"><span><CheckCircle2 size={15} />Läsa mejl · delade inkorgar</span><button className="office-link" disabled={busy || !canManage || !state.configuration.ready} onClick={connectMicrosoft}>{pending === 'connect' ? <LoaderCircle size={15} className="mail-integration-spin" /> : <ExternalLink size={15} />}{pending === 'connect' ? 'Öppnar Microsoft…' : activeConnections.length ? 'Anslut ytterligare konto' : 'Anslut Microsoft 365'}</button></div></div></article>
        <article className="office-panel mail-provider-card google"><span className="mail-google-mark" aria-hidden="true">G</span><div><div className="mail-provider-heading"><h3>Google / Gmail</h3><span className="mail-connection-status planned">Nästa koppling</span></div><p>Google-konton och delade flöden planeras efter Microsoft 365.</p><div className="mail-provider-footer"><span>Läsa mejl</span><button className="office-btn outline" disabled>Anslut Google</button></div></div></article></div>
      <article className="office-panel mail-mailboxes-panel"><div className="mail-section-heading"><div><h3>Anslutna inkorgar</h3><p>Inkorgarna och anslutningarna gäller bara detta bolag.</p></div><span>{state.mailboxes.length} inkorgar</span></div>
        {state.mailboxes.length ? <div className="mail-mailbox-table-wrap"><table className="mail-mailbox-table"><thead><tr><th>Inkorg</th><th>Typ</th><th>Åtkomst</th><th>Status</th><th><span className="mail-integration-sr-only">Hantera inkorg</span></th></tr></thead><tbody>{state.mailboxes.map(mailbox => {
          const connection = state.connections.find(item => item.id === mailbox.connectionId), active = !!connection && connected(connection);
          return <tr key={mailbox.id}><td><div className="mail-address-cell"><Mail size={20} /><div><strong>{mailbox.address}</strong><small>{mailbox.displayName}</small></div></div></td><td>{mailbox.type === 'shared' ? 'Delad' : 'Personlig'}</td><td><span className="mail-access-pill">Läsa mejl</span></td><td><span className={`mail-connection-status ${mailbox.enabled && active && !mailbox.lastError ? 'connected' : 'muted'}`}>{!mailbox.enabled ? 'Pausad' : !active ? 'Frånkopplad' : mailbox.lastError ? 'Kontrollera inkorgen' : 'Ansluten'}</span></td><td><button className="office-btn outline small" disabled={!canManage || busy} onClick={() => editMailbox(mailbox)}><Settings2 size={14} />Hantera<span className="mail-integration-sr-only"> {mailbox.address}</span></button></td></tr>;
        })}</tbody></table></div> : <div className="mail-integration-empty"><Mail size={28} /><p>Anslut ett Microsoft-konto för att visa dess inkorg. Lägg sedan till de delade inkorgar ni vill använda.</p></div>}
      </article>
      {form && <article ref={editorArea} className="office-panel mail-mailbox-editor"><div className="mail-section-heading"><div><h3>{form.id ? 'Behörighet för vald inkorg' : 'Lägg till delad inkorg'}</h3><p>{form.id ? form.address : 'Det anslutna Microsoft-kontot behöver ha åtkomst till den delade inkorgen.'}</p></div><button type="button" className="office-link" aria-label="Stäng inkorgsinställningar" disabled={formDisabled} onClick={() => setEditor(undefined)}><X size={18} /></button></div>
        <form onSubmit={saveMailbox}><div className="mail-integration-form">{!form.id && <label>Microsoft-konto<select value={form.connectionId} required disabled={formDisabled || !activeConnections.length} onChange={event => change({ connectionId: event.target.value })}><option value="">Välj ett anslutet konto</option>{activeConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.address}</option>)}</select></label>}
          <label>Inkorgens adress<input type="email" value={form.address} required readOnly={!!form.id} disabled={formDisabled} placeholder="info@foretaget.se" onChange={event => change({ address: event.target.value })} /></label>
          <label>Visningsnamn<input value={form.displayName} maxLength={150} disabled={formDisabled} placeholder="Kundförfrågningar" onChange={event => change({ displayName: event.target.value })} /></label></div>
          {!form.id && !activeConnections.length && <p className="mail-integration-field-help">Anslut ett Microsoft-konto innan du lägger till en delad inkorg.</p>}
          {form.id && <label className="mail-enabled-check"><input type="checkbox" checked={form.enabled} disabled={formDisabled} onChange={event => change({ enabled: event.target.checked })} /><span>Visa och synka inkorgen</span></label>}
          <AccessChoices users={users} values={form.allowedUserIds} disabled={formDisabled} onChange={allowedUserIds => change({ allowedUserIds })} />
          <div className="mail-editor-footer"><span className="mail-integration-field-help"><ShieldCheck size={14} />Åtkomsten omfattar läsning. Skicka svar aktiveras i en senare etapp.</span><button type="submit" className="office-btn" disabled={formDisabled || !form.connectionId || busy}>{pending === 'mailbox' ? <LoaderCircle size={15} className="mail-integration-spin" /> : <Save size={15} />}{pending === 'mailbox' ? 'Sparar…' : form.id ? 'Spara behörigheter' : 'Lägg till delad inkorg'}</button></div>
        </form>
      </article>}
      <div className="mail-integration-bottom-grid"><article className="office-panel mail-account-connections"><h3>Anslutna Microsoft-konton</h3>{state.connections.length ? <ul>{state.connections.map(connection => <li key={connection.id}><div><strong>{connection.address}</strong><small>{connection.displayName}</small><span className={`mail-connection-status ${connected(connection) ? 'connected' : 'muted'}`}>{connectionLabel(connection)}</span>{connection.lastError && <p className="mail-integration-field-help">{typeof connection.lastError === 'string' ? connection.lastError : connection.lastError.message}</p>}</div>{connected(connection) ? <button type="button" className="office-link danger" disabled={!canManage || busy} onClick={() => setDisconnecting({ scope, value: connection })}><Unplug size={14} />Koppla bort<span className="mail-integration-sr-only"> {connection.address}</span></button> : <button className="office-link" disabled={!canManage || busy || !state.configuration.ready} onClick={connectMicrosoft}>Anslut igen</button>}</li>)}</ul> : <p className="mail-integration-field-help">Inga konton har anslutits ännu.</p>}</article>
        <article className="office-panel mail-sync-panel"><div className="mail-section-heading"><h3>Synkning</h3><button type="button" className="office-link" disabled={!canManage || !state.capabilities.canRead || !enabledMailboxes.length || !!currentActivity?.syncing} onClick={() => void syncMailbox()}>{currentActivity?.syncing ? <LoaderCircle size={15} className="mail-integration-spin" /> : <RefreshCw size={15} />}{currentActivity?.syncing ? 'Synkar…' : 'Synka inkorgar'}</button></div><p>Nya mejl visas i Inkomna mejl. Läsning här markerar inga mejl som lästa hos Microsoft.</p>{enabledMailboxes.map(mailbox => <div className="mail-mailbox-sync" key={mailbox.id}><span>{mailbox.displayName || mailbox.address}</span><small>{mailbox.lastSyncedAt ? `Senast ${environmentTime(mailbox.lastSyncedAt)}` : 'Inte synkad ännu'}</small>{mailbox.lastError && <small className="mail-sync-error">{typeof mailbox.lastError === 'string' ? mailbox.lastError : mailbox.lastError.message}</small>}</div>)}{currentActivity?.syncError && <div className="mail-integration-feedback error" role="alert"><CircleAlert size={15} /><span>{currentActivity.syncError}</span></div>}{state.capabilities.canRead ? <Link className="office-btn outline" to="/mail"><Mail size={15} />Öppna Inkomna mejl</Link> : <p className="mail-integration-field-help">Behörigheten Läsa mejl behövs för att öppna och synka inkorgarna.</p>}</article></div>
    </>}
    {confirmation && matching && <DisconnectDialog connection={confirmation} busy={pending === 'disconnect'} onClose={() => setDisconnecting(undefined)} onConfirm={disconnect} />}
  </section>;
}
