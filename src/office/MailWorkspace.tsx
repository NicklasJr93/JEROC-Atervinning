import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Building2, CheckCircle2, ChevronRight, CircleAlert, FileText, Inbox, Mail, Paperclip, RefreshCw, Search, Settings2, UserRound, X } from 'lucide-react';
import { can, type OfficeUser } from './model';
import { useEnvironmentSession } from './EnvironmentSession';
import { OfficePageHeader } from './OfficePageHeader';
import { integrationReadScope } from './integration-read-cache';
import { mailApi, mailChangedEvent, mailIssueText, isCurrentMailChange, mayReadMail, useMailState, type MailCustomerMatch, type MailMailbox, type MailMessage, type MailMessageDetail, type MailMessages } from './mail-client';
import './mail.css';

const subjectOf = (message: Pick<MailMessage, 'subject'>) => message.subject?.trim() || '(Utan ämne)';
const senderOf = (message: MailMessage) => message.from.name?.trim() || message.from.address || 'Okänd avsändare';
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase();
function dateLabel(value?: string | null, full = false) {
  if (!value || Number.isNaN(Date.parse(value))) return 'Datum saknas';
  const sameDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date(value)) === new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', ...(full ? { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' } : sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }) }).format(new Date(value));
}
function attachmentSize(size: number) { return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} MB` : `${Math.max(0, Math.ceil(size / 1024))} kB`; }
export function safeOutlookLink(value?: string | null) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'].includes(url.hostname.toLowerCase())) return url.href;
  } catch { /* A provider link must be an absolute Outlook HTTPS URL. */ }
}
function CustomerSummary({ customer }: { customer: MailCustomerMatch }) {
  const privatePerson = customer.type === 'Privatperson';
  return <section className="office-panel mail-customer-panel" aria-label="Matchad kund">
    <header><span className="mail-customer-icon">{privatePerson ? <UserRound size={21} /> : <Building2 size={21} />}</span><div><small>Kundkort</small><h2>{customer.name}</h2></div></header>
    <span className="mail-match-status"><CheckCircle2 size={13} />E-postadress matchad</span>
    <dl><div><dt>Kund</dt><dd>{customer.customerNumber || customer.type}</dd></div>{customer.email && <div><dt>E-post</dt><dd>{customer.email}</dd></div>}{customer.phone && <div><dt>Telefon</dt><dd>{customer.phone}</dd></div>}{customer.address && <div><dt>Adress</dt><dd>{customer.address}{(customer.postalCode || customer.city) && <small>{[customer.postalCode, customer.city].filter(Boolean).join(' ')}</small>}</dd></div>}</dl>
    <Link className="office-link mail-customer-link" to={`/customers/${encodeURIComponent(customer.id)}?tab=overview`}>Öppna kundkort<ChevronRight size={14} /></Link>
  </section>;
}
function MailboxButton({ mailbox, selected, onClick }: { mailbox: MailMailbox; selected: boolean; onClick: () => void }) {
  return <button type="button" className={`mail-mailbox-choice${selected ? ' selected' : ''}`} aria-pressed={selected} onClick={onClick}>
    <Inbox size={18} /><span><strong>{mailbox.displayName || mailbox.address}</strong>{mailbox.displayName && mailbox.displayName !== mailbox.address && <small>{mailbox.address}</small>}</span>
    {mailbox.unreadCount > 0 && <b aria-label={`${mailbox.countsPartial ? 'Minst ' : ''}${mailbox.unreadCount} olästa`}>{mailbox.unreadCount > 99 ? '99+' : `${mailbox.unreadCount}${mailbox.countsPartial ? '+' : ''}`}</b>}
    {mailbox.lastError && <CircleAlert className="mail-mailbox-warning" size={13} aria-label="Inkorgen behöver kontrolleras" />}
  </button>;
}

export default function MailWorkspace({ user, actualUser, onNotice }: { user: OfficeUser; actualUser: OfficeUser; onNotice?: (message: string) => void }) {
  const { session, loading: sessionLoading, error: sessionError, refreshSession } = useEnvironmentSession();
  const { state, loading: stateLoading, error: stateError, refresh: refreshState } = useMailState(user, actualUser);
  const scope = integrationReadScope(actualUser, user, session);
  const identityRef = useRef(scope); identityRef.current = scope;
  const readable = mayReadMail(user, actualUser);
  const integrationVisible = can(user, 'integrationsRead') && can(actualUser, 'integrationsRead');
  const [query, setQuery] = useSearchParams();
  const inboxId = query.get('inbox') ?? '', selectedId = query.get('message') ?? '', selectedInbox = query.get('messageInbox') ?? inboxId;
  const unreadOnly = query.get('unread') === 'true';
  const [search, setSearch] = useState(query.get('q') ?? ''), [settledSearch, setSettledSearch] = useState(query.get('q') ?? '');
  const mailboxes = useMemo(() => state?.mailboxes.filter(mailbox => mailbox.enabled) ?? [], [state?.mailboxes]);
  const mailboxIds = JSON.stringify(mailboxes.map(mailbox => mailbox.id).sort());
  const inbox = mailboxes.find(mailbox => mailbox.id === inboxId);
  const selectedMailbox = mailboxes.find(mailbox => mailbox.id === selectedInbox);
  const listAvailable = readable && Boolean(scope && state?.capabilities.canRead && mailboxes.length && (!inboxId || inbox));
  const detailAvailable = readable && Boolean(scope && state?.capabilities.canRead && selectedMailbox && selectedId);
  const accessRef = useRef({ list: listAvailable, detail: detailAvailable }); accessRef.current = { list: listAvailable, detail: detailAvailable };
  const listKey = JSON.stringify([scope, inboxId, unreadOnly, settledSearch, mailboxIds]);
  const listKeyRef = useRef(listKey); listKeyRef.current = listKey;
  const [list, setList] = useState<MailMessages>(), [listLoading, setListLoading] = useState(false), [listError, setListError] = useState('');
  const [detail, setDetail] = useState<MailMessageDetail>(), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [customerId, setCustomerId] = useState(''), [syncing, setSyncing] = useState(false), [syncError, setSyncError] = useState('');
  const mounted = useRef(true), listSequence = useRef(0), detailSequence = useRef(0), syncBusy = useRef(false);
  const listController = useRef<AbortController | undefined>(undefined), detailController = useRef<AbortController | undefined>(undefined), syncController = useRef<AbortController | undefined>(undefined);
  const detailKey = `${scope}/${selectedInbox}/${selectedId}`;
  const detailKeyRef = useRef(detailKey); detailKeyRef.current = detailKey;
  const listScope = useRef(''), detailScope = useRef('');

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++listSequence.current; ++detailSequence.current; listController.current?.abort(); detailController.current?.abort(); syncController.current?.abort(); }; }, []);
  useEffect(() => {
    listController.current?.abort(); detailController.current?.abort(); syncController.current?.abort();
    ++listSequence.current; ++detailSequence.current; syncBusy.current = false;
    listScope.current = ''; detailScope.current = ''; setList(undefined); setDetail(undefined); setListLoading(false); setDetailLoading(false); setListError(''); setDetailError(''); setSyncError(''); setSyncing(false); setCustomerId('');
  }, [scope, readable]);
  useEffect(() => {
    if (listAvailable) return;
    ++listSequence.current; listController.current?.abort(); listScope.current = '';
    setList(undefined); setListLoading(false); setListError('');
  }, [listAvailable]);
  useEffect(() => {
    if (detailAvailable) return;
    ++detailSequence.current; detailController.current?.abort(); detailScope.current = '';
    setDetail(undefined); setDetailLoading(false); setDetailError(''); setCustomerId('');
  }, [detailAvailable]);
  useEffect(() => { setSearch(query.get('q') ?? ''); }, [query.get('q')]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettledSearch(search.trim());
      if (search.trim() !== (query.get('q') ?? '')) { const next = new URLSearchParams(query); if (search.trim()) next.set('q', search.trim()); else next.delete('q'); setQuery(next, { replace: true }); }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query, setQuery]);

  const loadMessages = useCallback(async (cursor?: string) => {
    if (!readable || !scope || !state?.capabilities.canRead || !mailboxes.length || (inboxId && !inbox)) return;
    listController.current?.abort();
    const controller = new AbortController(), sequence = ++listSequence.current;
    listController.current = controller;
    const valid = () => mounted.current && accessRef.current.list && !controller.signal.aborted && identityRef.current === scope && listKeyRef.current === listKey && listSequence.current === sequence;
    if (!cursor) { listScope.current = listKey; setList(undefined); }
    setListLoading(true); setListError('');
    try {
      const next = await mailApi.messages({ mailboxId: inboxId || undefined, unreadOnly, search: settledSearch || undefined, cursor }, controller.signal);
      if (!valid()) return;
      setList(previous => {
        if (!cursor || !previous) return next;
        const existing = new Set(previous.messages.map(message => `${message.mailboxId}/${message.id}`));
        return { ...next, messages: [...previous.messages, ...next.messages.filter(message => !existing.has(`${message.mailboxId}/${message.id}`))] };
      });
    } catch (failure) { if (valid()) setListError(failure instanceof Error ? failure.message : 'Inkorgen kunde inte hämtas.'); }
    finally { if (valid()) setListLoading(false); }
  }, [scope, readable, state?.capabilities.canRead, mailboxIds, inboxId, Boolean(inbox), unreadOnly, settledSearch, listKey]);
  useEffect(() => { if (!selectedId) void loadMessages(); return () => listController.current?.abort(); }, [loadMessages, selectedId]);

  const loadDetail = useCallback(async () => {
    if (!selectedId || !readable || !scope || !state?.capabilities.canRead || !selectedMailbox) return;
    detailController.current?.abort();
    const controller = new AbortController(), sequence = ++detailSequence.current; detailController.current = controller;
    const valid = () => mounted.current && accessRef.current.detail && !controller.signal.aborted && identityRef.current === scope && detailKeyRef.current === detailKey && detailSequence.current === sequence;
    detailScope.current = detailKey; setDetail(undefined); setCustomerId(''); setDetailLoading(true); setDetailError('');
    try {
      const next = await mailApi.message(selectedInbox, selectedId, controller.signal);
      if (valid()) { setDetail(next); if (next.matchStatus === 'matched' && next.matches.length === 1) setCustomerId(next.matches[0].id); }
    } catch (failure) { if (valid()) setDetailError(failure instanceof Error ? failure.message : 'Mejlet kunde inte öppnas.'); }
    finally { if (valid()) setDetailLoading(false); }
  }, [scope, readable, state?.capabilities.canRead, selectedId, selectedInbox, Boolean(selectedMailbox), detailKey]);
  useEffect(() => { if (selectedId) void loadDetail(); return () => detailController.current?.abort(); }, [loadDetail, selectedId]);
  useEffect(() => {
    const changed = (event: Event) => { if (!isCurrentMailChange(event)) return; if (selectedId) void loadDetail(); else void loadMessages(); };
    window.addEventListener(mailChangedEvent, changed);
    return () => window.removeEventListener(mailChangedEvent, changed);
  }, [selectedId, loadDetail, loadMessages]);

  function chooseInbox(mailboxId: string) { const next = new URLSearchParams(query); if (mailboxId) next.set('inbox', mailboxId); else next.delete('inbox'); next.delete('message'); next.delete('messageInbox'); setQuery(next); }
  function openMessage(message: MailMessage) { const next = new URLSearchParams(query); next.set('message', message.id); next.set('messageInbox', message.mailboxId); setQuery(next); }
  function closeMessage() { const next = new URLSearchParams(query); next.delete('message'); next.delete('messageInbox'); setQuery(next); }
  function changeUnread(value: boolean) { const next = new URLSearchParams(query); if (value) next.set('unread', 'true'); else next.delete('unread'); setQuery(next); }
  async function sync() {
    if (syncBusy.current || !readable || !scope || !state?.capabilities.canRead || !state.configuration.ready || !mailboxes.length) return;
    const expectedScope = scope, controller = new AbortController(); syncController.current = controller; syncBusy.current = true; setSyncing(true); setSyncError('');
    try {
      await mailApi.sync({ mailboxId: inboxId || undefined }, controller.signal);
      if (mounted.current && !controller.signal.aborted && identityRef.current === expectedScope) onNotice?.('Inkorgen har uppdaterats från Microsoft 365.');
    } catch (failure) { if (mounted.current && !controller.signal.aborted && identityRef.current === expectedScope) setSyncError(failure instanceof Error ? failure.message : 'Inkorgen kunde inte uppdateras.'); }
    finally { if (mounted.current && identityRef.current === expectedScope) { syncBusy.current = false; setSyncing(false); } }
  }
  const visibleList = listAvailable && listScope.current === listKey ? list : undefined;
  const visibleDetail = detailAvailable && detailScope.current === detailKey ? detail : undefined;
  const customer = visibleDetail?.matches.find(match => match.id === customerId);
  const outlookLink = safeOutlookLink(visibleDetail?.message.webLink);
  const connection = state?.connections.find(item => item.id === inbox?.connectionId);
  const lastUpdated = (inbox ? [inbox] : mailboxes).map(mailbox => mailbox.lastSyncedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const countsPartial = inbox ? inbox.countsPartial : mailboxes.some(mailbox => mailbox.countsPartial);
  const settingsLink = integrationVisible && <Link className="office-btn outline" to="/integrations?service=microsoft365"><Settings2 size={15} />Mejlinställningar</Link>;

  if (!readable) return <section className="office-panel mail-no-access"><CircleAlert size={20} /><h1>Inkomna mejl</h1><p>Du saknar behörighet att läsa företagets mejl.</p></section>;
  return <div className="mail-workspace">
    <OfficePageHeader className="mail-page-header" controls={!selectedId && <div className="mail-toolbar"><div className="mail-filter-tabs" aria-label="Mejlfilter"><button type="button" className={!unreadOnly ? 'active' : ''} aria-pressed={!unreadOnly} onClick={() => changeUnread(false)}>Alla mejl</button><button type="button" className={unreadOnly ? 'active' : ''} aria-pressed={unreadOnly} onClick={() => changeUnread(true)}>Olästa{(state?.totalUnread ?? 0) > 0 && <span>{state!.totalUnread}</span>}</button></div><label className="mail-search"><Search size={17} /><input aria-label="Sök avsändare eller ämne" placeholder="Sök avsändare eller ämne…" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} />{search && <button type="button" aria-label="Rensa mejlsökning" onClick={() => setSearch('')}><X size={14} /></button>}</label></div>}>
      {selectedId && <button type="button" className="office-back" onClick={closeMessage}><ArrowLeft size={14} />Till inkorgen</button>}
      <div className="mail-title"><div><h1>{selectedId ? visibleDetail ? subjectOf(visibleDetail.message) : 'Läs mejl' : 'Inkomna mejl'}</h1><p>{selectedId ? selectedMailbox?.address ?? 'Microsoft 365' : 'Alla företagets inkorgar på ett ställe'}</p></div><div className="mail-page-actions">{state?.capabilities.canRead && state.configuration.ready && mailboxes.length > 0 && <button type="button" className="office-btn outline" disabled={syncing || (Boolean(inboxId) && !inbox)} onClick={() => void sync()}><RefreshCw size={15} className={syncing ? 'mail-spin' : ''} />{syncing ? 'Uppdaterar…' : 'Uppdatera inkorg'}</button>}{settingsLink}</div></div>
    </OfficePageHeader>
    {(sessionError || stateError || syncError) && <div className="mail-alert" role="alert"><CircleAlert size={16} /><span>{syncError || stateError || sessionError}</span><button type="button" className="office-link" onClick={() => void (session ? refreshState(true) : refreshSession())}>Försök igen</button></div>}
    {state && !state.configuration.ready && mailboxes.length > 0 && <div className="mail-alert" role="status"><CircleAlert size={16} /><span>Mejlkopplingen behöver konfigureras för att uppdatera inkorgarna.</span></div>}
    {!session || !state ? <section className="office-panel mail-empty"><Mail size={30} /><h2>{sessionLoading || stateLoading ? 'Hämtar inkorgar…' : 'Inkorgarna är inte tillgängliga'}</h2><p>{sessionLoading || stateLoading ? 'Hämtar företagets anslutna brevlådor.' : 'Försök igen eller kontrollera mejlinställningarna.'}</p>{!sessionLoading && !stateLoading && <button type="button" className="office-btn outline" onClick={() => void (session ? refreshState(true) : refreshSession())}><RefreshCw size={14} />Hämta inkorgar</button>}</section>
      : !mailboxes.length ? <section className="office-panel mail-empty"><span className="mail-empty-icon"><Inbox size={32} /></span><h2>{state.connections.length ? 'Ingen inkorg tilldelad' : 'Anslut företagets första inkorg'}</h2><p>{state.connections.length ? 'En administratör kan ge dig åtkomst till en av företagets inkorgar.' : 'Koppla Microsoft 365 under Integrationer för att samla företagets inkomna mejl här.'}</p>{settingsLink}</section>
      : <><div className={`mail-layout${selectedId ? ' has-detail' : ''}`}>
        <aside className="office-panel mail-mailboxes" aria-label="Inkorgar"><h2>Inkorgar</h2><button type="button" className={`mail-mailbox-choice${!inboxId ? ' selected' : ''}`} aria-pressed={!inboxId} onClick={() => chooseInbox('')}><Inbox size={19} /><span><strong>Alla inkorgar</strong></span>{state.totalUnread > 0 && <b>{state.totalUnread > 99 ? '99+' : state.totalUnread}</b>}</button><div className="mail-mailbox-divider" />{mailboxes.map(mailbox => <MailboxButton key={mailbox.id} mailbox={mailbox} selected={inboxId === mailbox.id} onClick={() => chooseInbox(mailbox.id)} />)}{integrationVisible && <Link className="office-link mail-manage-link" to="/integrations?service=microsoft365"><Settings2 size={14} />Hantera inkorgar</Link>}</aside>
        <main className="mail-content">
          {selectedId ? !detailAvailable ? <section className="office-panel mail-empty"><CircleAlert size={24} /><h2>Mejlet är inte tillgängligt</h2><p>Inkorgen finns inte eller du saknar behörighet till den.</p></section> : detailError ? <section className="office-panel mail-empty"><CircleAlert size={24} /><h2>Mejlet kunde inte öppnas</h2><p role="alert">{detailError}</p><button type="button" className="office-btn outline" onClick={() => void loadDetail()}>Försök igen</button></section> : !visibleDetail ? <section className="office-panel mail-empty" aria-busy={detailLoading}><Mail size={26} /><h2>Hämtar mejlet…</h2></section> : <div className="mail-reading-layout">
            <article className="office-panel mail-reading-panel" aria-label="Mejlinnehåll"><header><span className="mail-sender-avatar">{initials(senderOf(visibleDetail.message))}</span><div><h2>{senderOf(visibleDetail.message)}</h2><span>{visibleDetail.message.from.address}</span></div><time dateTime={visibleDetail.message.receivedAt}>{dateLabel(visibleDetail.message.receivedAt, true)}</time></header><div className="mail-recipient-line"><span>Till: {visibleDetail.message.to?.map(address => address.address).join(', ') || selectedMailbox?.address}</span>{outlookLink && <a className="office-link" href={outlookLink} target="_blank" rel="noopener noreferrer">Öppna i Outlook<ArrowUpRight size={14} /></a>}</div><div className="mail-body">{visibleDetail.message.bodyText || 'Mejlet saknar textinnehåll.'}</div>{visibleDetail.message.attachments?.length > 0 && <section className="mail-attachments" aria-label="Bilagor"><h3><Paperclip size={15} />Bilagor <small>{visibleDetail.message.attachments.length}</small></h3>{visibleDetail.message.attachments.map(attachment => <div className="mail-attachment" key={attachment.id}><FileText size={21} /><span><strong>{attachment.name}</strong><small>{attachmentSize(attachment.size)}{attachment.contentType ? ` · ${attachment.contentType}` : ''}</small></span></div>)}{outlookLink && <small>Bilagorna kan öppnas i Outlook.</small>}</section>}</article>
            <aside className="mail-customer-aside">{visibleDetail.matchStatus === 'multiple' && <section className="office-panel mail-customer-choice"><h2>Välj kundkort</h2><p>Avsändarens e-postadress finns på flera kunder.</p><label>Kund<select aria-label="Välj matchad kund" value={customerId} onChange={event => setCustomerId(event.target.value)}><option value="">Välj kund…</option>{visibleDetail.matches.map(match => <option key={match.id} value={match.id}>{match.name}{match.customerNumber ? ` · ${match.customerNumber}` : ''}</option>)}</select></label></section>}{customer ? <CustomerSummary customer={customer} /> : visibleDetail.matchStatus !== 'multiple' && <section className="office-panel mail-customer-empty"><UserRound size={22} /><h2>{visibleDetail.matchStatus === 'not-authorized' ? 'Kundkortet är inte tillgängligt' : 'Ingen kund matchad'}</h2><p>{visibleDetail.matchStatus === 'not-authorized' ? 'Din behörighet ger inte åtkomst till kunduppgifterna.' : 'Avsändarens e-postadress saknar en exakt matchning i kundregistret.'}</p></section>}</aside>
          </div>
            : <section className="office-panel mail-list-panel" aria-label="Mejlinkorg"><header><h2>{inbox?.displayName || inbox?.address || 'Inkorg'}</h2><span>{inbox ? inbox.unreadCount : state.totalUnread}{countsPartial ? '+' : ''} olästa</span>{listLoading && <RefreshCw className="mail-spin" size={14} aria-label="Hämtar mejl" />}</header>{(inboxId && !inbox) ? <div className="mail-list-empty"><CircleAlert size={24} /><h3>Inkorgen är inte tillgänglig</h3><p>Välj en av dina tillgängliga inkorgar.</p></div> : listError ? <div className="mail-list-empty"><CircleAlert size={24} /><p role="alert">{listError}</p><button type="button" className="office-btn outline" onClick={() => void loadMessages()}>Försök igen</button></div> : !visibleList || !visibleList.messages.length ? <div className="mail-list-empty" aria-busy={listLoading}><Inbox size={28} /><h3>{listLoading ? 'Hämtar mejl…' : settledSearch ? 'Inga mejl matchar sökningen' : unreadOnly ? 'Inga olästa mejl' : 'Inkorgen är tom'}</h3><p>{listLoading ? 'Hämtar inkomna meddelanden.' : settledSearch ? 'Prova en annan avsändare eller ett annat ämne.' : unreadOnly ? 'Välj Alla mejl för att se övriga meddelanden.' : 'Uppdatera inkorgen för att hämta mejl från Microsoft 365.'}</p></div> : <ul className="mail-message-list">{visibleList.messages.map(message => <li key={`${message.mailboxId}/${message.id}`}><button type="button" className={`mail-message-row${message.isRead ? '' : ' is-unread'}`} aria-label={`Öppna mejl: ${subjectOf(message)}`} onClick={() => openMessage(message)}><span className="mail-read-dot" aria-label={message.isRead ? 'Läst i Outlook' : 'Oläst i Outlook'} /><span className="mail-row-sender"><strong>{senderOf(message)}</strong><small>{message.from.address}</small></span><span className="mail-row-subject"><strong>{subjectOf(message)}{message.hasAttachments && <Paperclip size={13} aria-label="Har bilaga" />}</strong><small>{message.bodyPreview}</small></span><span className="mail-row-meta"><span className="mail-mailbox-tag">{mailboxes.find(mailbox => mailbox.id === message.mailboxId)?.displayName || mailboxes.find(mailbox => mailbox.id === message.mailboxId)?.address || 'Inkorg'}</span><time dateTime={message.receivedAt} title={dateLabel(message.receivedAt, true)}>{dateLabel(message.receivedAt)}</time></span><ChevronRight size={15} className="mail-row-chevron" /></button></li>)}</ul>}{visibleList?.hasMore && <div className="mail-load-more"><button type="button" className="office-btn outline" disabled={listLoading || !visibleList.nextCursor} onClick={() => void loadMessages(visibleList.nextCursor || undefined)}>{listLoading ? 'Hämtar…' : 'Visa fler mejl'}</button></div>}</section>}
        </main>
      </div><footer className="mail-inbox-footer">{connection?.lastError || inbox?.lastError ? <><CircleAlert size={13} />{mailIssueText(inbox?.lastError || connection?.lastError)}</> : lastUpdated ? <><CheckCircle2 size={13} />Senast uppdaterad {dateLabel(lastUpdated, true)}</> : <><Mail size={13} />Microsoft 365 · Inkorgen har inte uppdaterats ännu</>}<span>{countsPartial ? 'Senaste synkroniserade mejlen · ' : ''}Lässtatus från Outlook</span></footer></>}
  </div>;
}
