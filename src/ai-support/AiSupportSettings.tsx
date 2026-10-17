import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Archive, ArrowUpRight, AudioLines, BookOpen, Check, CheckCircle2, ChevronRight, CircleHelp, FileText, Headphones, Info, Library, LoaderCircle, LockKeyhole, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Square, Volume2, X } from 'lucide-react';
import { usePlatformContext } from '../platform/PlatformGate';
import { currentPlatformSession } from '../platform/session';
import { aiSupportDenied, AiSupportError, aiSupportScope, aiSupportScopeKey, previewAiVoice, readAiSupport, saveAiSupport } from './client';
import { categoryLabels, type AiSettings, type AiSupportState, type KnowledgeEditor, type KnowledgeItem } from './types';
import './ai-support.css';

type Tab = 'knowledge' | 'voice' | 'protection';
const editorOf = (item?: KnowledgeItem, sites: string[] = []): KnowledgeEditor => ({ ...(item ? { id: item.id } : {}), title: item?.title ?? '', answer: item?.answer ?? '', category: item?.category ?? 'general', siteIds: item?.siteIds ?? sites, publicApproved: item?.publicApproved ?? false });
const statusLabels = { draft: 'Utkast', published: 'Publicerat', archived: 'Arkiverat' };
const messageOf = (error: unknown) => error instanceof TypeError ? 'Kunde inte nå servern. Din text finns kvar här. Kontrollera anslutningen och hämta aktuell version.' : error instanceof Error ? error.message : 'Ändringen kunde inte sparas.';
const dateLabel = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short' }).format(date) : value; };
function RuntimeInfo({ data }: { data: AiSupportState }) {
  const runtime = data.runtime;
  if (!runtime) return null;
  const voiceName = data.voices.find(voice => voice.id === runtime.voice)?.name ?? runtime.voice;
  return <section className="ai-support-engine" aria-label="Aktiv röstmotor">
    <AudioLines size={21} />
    <div className="ai-support-engine-content">
      <dl><div><dt>Röstmotor</dt><dd>{runtime.engine === 'live' ? 'GPT-Live' : 'Realtime'}</dd></div><div><dt>Modell</dt><dd>{runtime.model}</dd></div><div><dt>Röst för nästa samtal</dt><dd>{voiceName}</dd></div></dl>
      {runtime.notice && <p>{runtime.notice}</p>}
    </div>
  </section>;
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const active = document.activeElement instanceof HTMLElement ? document.activeElement : null; ref.current?.showModal(); return () => { ref.current?.close(); active?.focus(); }; }, []);
  return <dialog ref={ref} className="ai-support-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}><header><h2>{title}</h2><button type="button" aria-label="Stäng dialogen" onClick={onClose}><X size={20} /></button></header>{children}</dialog>;
}

export default function AiSupportSettings() {
  const platform = usePlatformContext(), session = platform?.session ?? currentPlatformSession();
  const scope = useMemo(() => aiSupportScope(session), [aiSupportScopeKey(session)]), key = scope.key;
  const scopeRef = useRef(key); scopeRef.current = key;
  const mounted = useRef(true), epoch = useRef(0), reading = useRef<AbortController | null>(null), writing = useRef<AbortController | null>(null), previewing = useRef<AbortController | null>(null);
  const [stored, setStored] = useState<{ key: string; data: AiSupportState }>(), [tab, setTab] = useState<Tab>('knowledge');
  const [editor, setEditor] = useState<KnowledgeEditor>(editorOf()), [editorBase, setEditorBase] = useState(JSON.stringify(editorOf()));
  const [profile, setProfile] = useState<AiSettings>(), [profileBase, setProfileBase] = useState('');
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('active'), [loading, setLoading] = useState(false), [busy, setBusy] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false), [previewVoice, setPreviewVoice] = useState('');
  const [audioUrl, setAudioUrl] = useState(''), [audioPlaying, setAudioPlaying] = useState(false), [audioNeedsGesture, setAudioNeedsGesture] = useState(false);
  const [archive, setArchive] = useState(false), [importing, setImporting] = useState(false), [articleId, setArticleId] = useState('');
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const audio = useRef<HTMLAudioElement>(null), urlRef = useRef('');
  const pendingCommand = useRef<{ signature: string; body: Record<string, unknown> } | undefined>(undefined);
  const data = scope.allowed && stored?.key === key ? stored.data : undefined;
  const dataRef = useRef(data); dataRef.current = data;
  const previewAvailable = data?.runtime?.previewAvailable !== false;
  const editorDirty = JSON.stringify(editor) !== editorBase, profileDirty = !!profile && JSON.stringify(profile) !== profileBase;
  const dirty = editorDirty || profileDirty, dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const editorDirtyRef = useRef(editorDirty); editorDirtyRef.current = editorDirty;
  const profileDirtyRef = useRef(profileDirty); profileDirtyRef.current = profileDirty;
  const current = useCallback(() => mounted.current && scopeRef.current === key && aiSupportScopeKey() === key, [key]);
  const stopAudio = useCallback(() => {
    previewing.current?.abort(); previewing.current = null;
    if (audio.current) { audio.current.pause(); audio.current.removeAttribute('src'); audio.current.load(); }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = ''; setAudioUrl(''); setAudioPlaying(false); setAudioNeedsGesture(false); setPreviewVoice('');
  }, []);
  const putEditor = useCallback((value: KnowledgeEditor) => { setEditor(value); setEditorBase(JSON.stringify(value)); editorDirtyRef.current = false; }, []);
  const hydrate = useCallback((value: AiSupportState, preserve = false) => {
    if (value.runtime?.previewAvailable === false) stopAudio();
    setStored({ key, data: value });
    if (!preserve || !profileDirtyRef.current) { setProfile(value.settings); setProfileBase(JSON.stringify(value.settings)); profileDirtyRef.current = false; }
    if (!preserve || !editorDirtyRef.current) {
      setEditor(previous => {
        const item = value.knowledge.find(item => item.id === previous.id) ?? (!preserve ? value.knowledge.find(item => item.status !== 'archived') : undefined);
        const next = editorOf(item, value.capabilities.globalWrite ? [] : value.sites.slice(0, 1).map(site => site.id));
        setEditorBase(JSON.stringify(next)); return next;
      });
    }
  }, [key, stopAudio]);
  const clearPrivate = useCallback(() => {
    epoch.current++; reading.current?.abort(); writing.current?.abort(); reading.current = null; writing.current = null;
    stopAudio(); setStored(undefined); setProfile(undefined); setProfileBase(''); putEditor(editorOf()); dirtyRef.current = false;
    pendingCommand.current = undefined; setDiscardAction(null); setArchive(false); setImporting(false); setArticleId(''); setBusy(''); setLoading(false); setNotice(''); setConflict(false);
  }, [stopAudio, putEditor]);
  const fail = useCallback((failure: unknown) => {
    if (!current()) return;
    if (aiSupportDenied(failure)) { clearPrivate(); window.dispatchEvent(new Event('scrappilot:check-platform-session')); }
    if (failure instanceof AiSupportError && failure.status === 409) setConflict(true);
    setError(messageOf(failure));
  }, [clearPrivate, current]);
  const load = useCallback(async (preserve = true) => {
    if (!scope.allowed || reading.current || writing.current) return;
    const controller = new AbortController(), version = epoch.current; reading.current = controller; setLoading(true);
    const valid = () => current() && version === epoch.current && reading.current === controller && !controller.signal.aborted;
    try {
      const value = await readAiSupport(scope, controller.signal); if (!valid()) return;
      if ((dataRef.current?.revision ?? -1) <= value.revision) hydrate(value, preserve);
      setError(''); setConflict(false);
      if (preserve && dirtyRef.current) setNotice('Aktuell serverversion hämtad. Dina osparade ändringar finns kvar. Granska och spara när du är klar.');
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) setLoading(false); if (reading.current === controller) reading.current = null; }
  }, [scope, current, hydrate, fail]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; reading.current?.abort(); writing.current?.abort(); stopAudio(); }; }, [stopAudio]);
  useEffect(() => { clearPrivate(); setError(''); setTab('knowledge'); void load(false); }, [key, clearPrivate, load]);
  const discard = useCallback(() => {
    const value = dataRef.current; if (!value) return;
    putEditor(editorOf(value.knowledge.find(item => item.id === editor.id), value.capabilities.globalWrite ? [] : value.sites.slice(0, 1).map(site => site.id)));
    setProfile(value.settings); setProfileBase(JSON.stringify(value.settings)); dirtyRef.current = false; profileDirtyRef.current = false;
  }, [editor.id, putEditor]);
  const guarded = (action: () => void) => { if (dirtyRef.current) setDiscardAction(() => action); else action(); };
  useEffect(() => {
    const confirmDiscard = () => !dirtyRef.current || window.confirm('Du har osparade ändringar i AI-supporten. Lämna utan att spara?');
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const beforeNavigation = (event: Event) => { if (!confirmDiscard()) event.preventDefault(); else if (dirtyRef.current) discard(); };
    const platformNavigation = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('.platform-topbar button, .platform-context-menu button') : null;
      if (!target || !dirtyRef.current) return;
      if (!confirmDiscard()) { event.preventDefault(); event.stopImmediatePropagation(); } else discard();
    };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('scrappilot:before-ai-support-navigation', beforeNavigation); document.addEventListener('click', platformNavigation, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('scrappilot:before-ai-support-navigation', beforeNavigation); document.removeEventListener('click', platformNavigation, true); };
  }, [discard]);
  const mutate = async (name: string, path: string, payload: Record<string, unknown>, after?: (value: AiSupportState) => void) => {
    if (!data || writing.current || !current()) return;
    reading.current?.abort(); reading.current = null; setLoading(false);
    const controller = new AbortController(), version = epoch.current; writing.current = controller; setBusy(name); setError(''); setNotice('');
    const signature = JSON.stringify([path, payload]);
    // A response can be lost after commit. Keep the complete original request,
    // including its old CAS revision, for an explicit idempotent retry.
    if (pendingCommand.current?.signature !== signature || path === '/settings') pendingCommand.current = { signature, body: { expectedRevision: data.revision, ...(path === '/settings' ? {} : { requestId: crypto.randomUUID() }), ...payload } };
    const valid = () => current() && version === epoch.current && writing.current === controller && !controller.signal.aborted;
    try {
      const value = await saveAiSupport(scope, path, pendingCommand.current.body, controller.signal); if (!valid()) return;
      hydrate(value, true); after?.(value); pendingCommand.current = undefined; setConflict(false);
      setNotice(name === 'archive' ? 'Svaret har arkiverats och används inte längre i nya samtal.' : name === 'import' ? 'Artikelns kundinformation har sparats som utkast. Granska texten innan du publicerar.' : name === 'draft' ? 'Utkastet är sparat. Det används inte i samtal förrän det har granskats och publicerats.' : 'Ändringarna är sparade. De används i nya samtal.');
    } catch (failure) { if (valid()) { if (failure instanceof AiSupportError && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) pendingCommand.current = undefined; fail(failure); } }
    finally { if (valid()) setBusy(''); if (writing.current === controller) writing.current = null; }
  };
  const edit = (patch: Partial<KnowledgeEditor>) => setEditor(previous => ({ ...previous, ...patch, publicApproved: false }));
  const savedItem = data?.knowledge.find(item => item.id === editor.id), canEdit = !!data?.capabilities.write && savedItem?.status !== 'archived' && (!savedItem || data.capabilities.globalWrite || savedItem.siteIds.length > 0);
  const saveKnowledge = (publish: boolean) => {
    if (!editor.title.trim() || !editor.answer.trim()) { setError('Fyll i en rubrik och ett svar till kunden.'); return; }
    if (!data?.capabilities.globalWrite && !editor.siteIds.length) { setError('Välj minst en anläggning.'); return; }
    if (publish && !editor.publicApproved) { setError('Bekräfta att du har kontrollerat informationen innan svaret publiceras.'); return; }
    void mutate(publish ? 'publish' : 'draft', '/knowledge', { ...editor, status: publish ? 'published' : 'draft', publicApproved: publish && editor.publicApproved }, value => {
      const item = value.knowledge.find(item => item.id === (value.saved?.knowledgeId ?? editor.id)) ?? value.knowledge.find(item => item.title === editor.title && item.answer === editor.answer);
      if (item) putEditor(editorOf(item));
    });
  };
  const preview = async (voice: string) => {
    if (!profile || !data?.capabilities.settingsWrite || data.runtime?.previewAvailable === false || previewing.current || !current()) return;
    stopAudio(); const controller = new AbortController(), version = epoch.current; previewing.current = controller; setPreviewVoice(voice); setError('');
    const valid = () => current() && version === epoch.current && previewing.current === controller && !controller.signal.aborted;
    try {
      const value = await previewAiVoice(scope, { voice, profile: { tone: profile.tone, pace: profile.pace, pronunciationText: profile.pronunciationText } }, controller.signal); if (!valid()) return;
      const bytes = Uint8Array.from(atob(value.audioBase64), char => char.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type: value.mimeType }));
      urlRef.current = url; setAudioUrl(url);
      if (audio.current) { audio.current.src = url; try { await audio.current.play(); if (valid()) setAudioPlaying(true); } catch { if (valid()) setAudioNeedsGesture(true); } }
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (previewing.current === controller) { previewing.current = null; setPreviewVoice(''); } }
  };
  const visible = data?.knowledge.filter(item => (filter === 'active' ? item.status !== 'archived' : item.status === filter) && `${item.title} ${item.answer}`.toLocaleLowerCase('sv').includes(query.toLocaleLowerCase('sv'))) ?? [];
  const switchTab = (next: Tab) => { if (next !== tab) guarded(() => { stopAudio(); setTab(next); }); };
  if (!scope.allowed) return <section className="ai-support ai-support-unavailable"><ShieldCheck /><h2>AI-support</h2><p>Du behöver vara behörig VD eller systemadministratör i det valda bolaget.</p></section>;
  return <section className="ai-support" aria-label="AI-supportinställningar">
    <audio ref={audio} className="ai-support-audio" onEnded={() => setAudioPlaying(false)} />
    <header className="ai-support-hero"><div className="ai-support-hero-icon"><Headphones size={27} /></div><div><span className="ai-support-eyebrow">AI-KUNDMOTTAGNING</span><h2>Ert bemötande. Er kunskap.</h2><p>Lär kundmottagningen det ni vill att kunderna ska få veta.</p></div><a className="ai-support-button primary" href="/rosttest" target="_blank" rel="noopener noreferrer"><Headphones size={17} />Testa samtal<ArrowUpRight size={15} /></a></header>
    <nav className="ai-support-tabs" aria-label="AI-supportens inställningar" role="tablist">{([['knowledge', BookOpen, 'Kunskap'], ['voice', AudioLines, 'Röst & bemötande'], ['protection', ShieldCheck, 'Skydd & gränser']] as const).map(([id, Icon, label]) => <button key={id} type="button" role="tab" disabled={!!busy} aria-selected={tab === id} aria-controls={`ai-support-${id}`} id={`ai-tab-${id}`} onClick={() => switchTab(id)}><Icon size={18} />{label}</button>)}<span className={`ai-support-save-state ${dirty ? 'dirty' : ''}`}>{dirty ? <><span />Osparade ändringar</> : data ? <><Check size={15} />Sparat</> : null}</span></nav>
    {error && <div className="ai-support-notice error" role="alert"><Info size={18} /><div>{error}{conflict && <button type="button" onClick={() => void load(true)} disabled={loading}>Hämta aktuell version</button>}</div></div>}
    {notice && <div className="ai-support-notice success" role="status"><CheckCircle2 size={18} />{notice}</div>}
    {!data ? <div className="ai-support-empty">{loading ? <><LoaderCircle className="spin" /><h3>Hämtar AI-supporten</h3></> : <><Library /><h3>Kunskapsbanken kunde inte visas</h3><p>Hämta sidan igen för att se aktuell information.</p><button className="ai-support-button" onClick={() => void load(false)}>Försök igen</button></>}</div> : <>
      <RuntimeInfo data={data} />
      {tab === 'knowledge' && <div id="ai-support-knowledge" role="tabpanel" aria-labelledby="ai-tab-knowledge">
        <div className="ai-support-section-title"><div><h3>Kunskap som går att lita på</h3><p>Skriv korta, tydliga svar. Ni avgör vad som får sägas till kunder.</p></div><div className="ai-support-toolbar"><button type="button" className="ai-support-button icon-only" aria-label="Uppdatera kunskapsbanken" disabled={loading || !!busy} onClick={() => void load(true)}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button><button type="button" className="ai-support-button" disabled={!data.capabilities.write || !!busy} onClick={() => guarded(() => { setArticleId(data.articleCandidates[0]?.id ?? ''); setImporting(true); })}><FileText size={16} />Från artikel</button><button type="button" className="ai-support-button primary" disabled={!data.capabilities.write || !!busy} onClick={() => guarded(() => putEditor(editorOf(undefined, data.capabilities.globalWrite ? [] : data.sites.slice(0, 1).map(site => site.id))))}><Plus size={17} />Nytt svar</button></div></div>
        <div className="ai-support-knowledge-layout"><aside className="ai-support-library" aria-label="Kunskapsbank"><div className="ai-support-library-head"><h4>Era svar <span>{data.stats.total}</span></h4><label className="ai-support-search"><Search size={17} /><input aria-label="Sök i kunskapsbanken" value={query} onChange={event => setQuery(event.target.value)} placeholder="Sök efter ett svar…" /></label><select aria-label="Visa kunskapsstatus" value={filter} onChange={event => setFilter(event.target.value)}><option value="active">Aktiva svar</option><option value="published">Publicerade</option><option value="draft">Utkast</option><option value="archived">Arkiverade</option></select></div><div className="ai-support-answer-list">{visible.map(item => <button type="button" key={item.id} className={editor.id === item.id ? 'selected' : ''} aria-label={`Redigera ${item.title}`} aria-pressed={editor.id === item.id} onClick={() => guarded(() => putEditor(editorOf(item)))}><span className="ai-support-answer-icon"><BookOpen size={17} /></span><span><strong>{item.title}</strong><small>{categoryLabels[item.category]} · version {item.version}</small><span className={`ai-support-pill ${item.status}`}>{statusLabels[item.status]}</span></span><ChevronRight size={15} /></button>)}{!visible.length && <div className="ai-support-list-empty"><BookOpen size={25} /><p>{query ? 'Inga svar matchar sökningen.' : 'Här samlar ni era svar till kunder.'}</p></div>}</div><div className="ai-support-budget"><span><strong>{data.stats.published}</strong> / {data.stats.maxPublished} publicerade svar</span><progress max={Math.max(1, data.stats.maxPublishedCharacters)} value={data.stats.publishedCharacters} /><small>{data.stats.publishedCharacters.toLocaleString('sv-SE')} / {data.stats.maxPublishedCharacters.toLocaleString('sv-SE')} tecken · högst {data.stats.maxTotal} sparade svar</small></div></aside>
          <section className="ai-support-editor" aria-label="Redigera kunskap"><div className="ai-support-editor-heading"><span className="ai-support-editor-symbol"><FileText size={21} /></span><div><h3>{savedItem ? 'Redigera svar' : 'Ett nytt svar'}</h3><p>{savedItem ? `Version ${savedItem.version} · uppdaterat ${dateLabel(savedItem.updatedAt)}` : 'Börja som utkast och publicera när innehållet är granskat.'}</p></div>{savedItem && <span className={`ai-support-pill ${savedItem.status}`}>{statusLabels[savedItem.status]}</span>}</div>
            {savedItem?.status === 'published' && <div className="ai-support-inline-info"><CheckCircle2 size={17} />Kundmottagningen använder version {savedItem.version} tills du sparar en ändring.</div>}
            {savedItem && !data.capabilities.globalWrite && !savedItem.siteIds.length && <div className="ai-support-inline-info"><LockKeyhole size={17} />Detta bolagsgemensamma svar kan läsas här. En administratör med tillgång till alla anläggningar kan ändra det.</div>}
            {savedItem?.status === 'archived' && <div className="ai-support-inline-info"><Archive size={17} />Detta svar är arkiverat och används inte i samtal.</div>}
            <form onSubmit={event => { event.preventDefault(); saveKnowledge(false); }}><fieldset disabled={!canEdit || !!busy}><div className="ai-support-field-row"><label className="grow">Rubrik<input value={editor.title} maxLength={160} onChange={event => edit({ title: event.target.value })} placeholder="Till exempel: Vilken kopparkabel tar vi emot?" required /></label><label>Kategori<select value={editor.category} onChange={event => edit({ category: event.target.value as KnowledgeEditor['category'] })}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><label>Svar till kunden<textarea rows={9} maxLength={3000} value={editor.answer} onChange={event => edit({ answer: event.target.value })} placeholder="Skriv det kunden ska få veta. Använd bara fakta som ni kan bekräfta." required /></label><div className="ai-support-answer-hint"><Info size={14} />Skriv kundinformation här. Interna anteckningar, priser och personuppgifter hör inte hemma i svaret.<span>{editor.answer.length.toLocaleString('sv-SE')} tecken</span></div>
              <fieldset className="ai-support-sites"><legend>Anläggningar</legend><p>Var gäller det här svaret?</p>{data.capabilities.globalWrite && <label className="ai-support-check"><input type="checkbox" checked={!editor.siteIds.length} onChange={event => edit({ siteIds: event.target.checked ? [] : data.sites.slice(0, 1).map(site => site.id) })} />Alla anläggningar</label>}<div className="ai-support-site-options">{data.sites.map(site => <label key={site.id} className="ai-support-check"><input type="checkbox" checked={editor.siteIds.includes(site.id)} onChange={event => edit({ siteIds: event.target.checked ? [...editor.siteIds, site.id] : editor.siteIds.filter(id => id !== site.id) })} />{site.name}</label>)}</div></fieldset>
              <label className={`ai-support-approval ${editor.publicApproved ? 'checked' : ''}`}><input type="checkbox" checked={editor.publicApproved} onChange={event => setEditor(previous => ({ ...previous, publicApproved: event.target.checked }))} /><ShieldCheck size={20} /><span><strong>Jag har kontrollerat att informationen får lämnas till kunder</strong><small>Godkännandet gäller den här texten och de valda anläggningarna.</small></span></label>
              <div className="ai-support-editor-footer">{savedItem && <button type="button" className="ai-support-text-button danger" onClick={() => setArchive(true)}><Archive size={16} />Arkivera</button>}<div><button type="submit" className="ai-support-button">{busy === 'draft' && <LoaderCircle size={16} className="spin" />}Spara utkast</button><button type="button" className="ai-support-button primary" onClick={() => saveKnowledge(true)}>{busy === 'publish' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{savedItem?.status === 'published' ? 'Spara och publicera' : 'Publicera svar'}</button></div></div>
            </fieldset></form>
          </section></div>
        <section className="ai-support-suggestions" aria-label="Förslag att lära kundmottagningen"><div className="ai-support-section-title"><div><h3><Sparkles size={19} />Bra att lära kundmottagningen</h3><p>Förslag blir utkast. Fyll i bolagets uppgifter och granska svaret först.</p></div></div><div className="ai-support-suggestion-grid">{data.suggestions.map(item => <button type="button" key={item.id} disabled={!data.capabilities.write || !!busy} onClick={() => guarded(() => { const sites = data.capabilities.globalWrite ? [] : data.sites.slice(0, 1).map(site => site.id); setEditor({ title: item.title, answer: item.answer, category: item.category, siteIds: sites, publicApproved: false }); setEditorBase(JSON.stringify(editorOf(undefined, sites))); editorDirtyRef.current = true; dirtyRef.current = true; })}><CircleHelp size={18} /><span><strong>{item.title}</strong><small>{item.reason}</small></span><Plus size={16} /></button>)}</div></section>
        <details className="ai-support-runtime"><summary><ShieldCheck size={18} /><span>Vad kundmottagningen får se</span><span>{data.runtimePreview?.items.length ?? 0} svar</span></summary>{data.runtimePreview ? <div>{!data.settings.enabled && <p><strong>AI-kundmottagningen är inaktiv. Nya samtal kan inte startas.</strong></p>}<p>Aktuellt underlag för <strong>{data.runtimePreview.siteName}</strong> · revision {data.runtimePreview.revision} · {data.runtimePreview.characters.toLocaleString('sv-SE')} tecken. Ett nytt samtal får de godkända svar som gäller på dess anläggning.</p>{data.runtimePreview.items.map(item => <article key={item.id}><h4>{item.title}<span>Version {item.version}</span></h4><p>{item.answer}</p></article>)}{!data.runtimePreview.items.length && <p>Inga godkända svar är tillgängliga på den här anläggningen ännu.</p>}</div> : <p>Inget kundunderlag är tillgängligt. Publicera granskade svar på en aktiv anläggning.</p>}</details>
      </div>}
      {tab === 'voice' && profile && <section id="ai-support-voice" role="tabpanel" aria-labelledby="ai-tab-voice"><div className="ai-support-section-title"><div><h3>En röst som känns som ni</h3><p>Röst och bemötande används när nästa testsamtal startar.</p></div></div>{!data.capabilities.settingsWrite && <div className="ai-support-inline-info"><LockKeyhole size={17} />Bolagets gemensamma röstinställningar ändras av en behörig administratör med tillgång till alla anläggningar.</div>}<div className="ai-support-voice-layout"><section className="ai-support-voice-card"><div className="ai-support-card-title"><AudioLines size={23} /><div><h3>Välj röst</h3><p>{previewAvailable ? 'Provlyssna och hitta rätt känsla.' : 'Välj en röst för nästa testsamtal.'}</p></div></div><div className="ai-support-voice-grid">{data.voices.map(voice => <div key={voice.id} className={`ai-support-voice-option ${profile.voice === voice.id ? 'selected' : ''}`}><button type="button" aria-label={`Välj röst ${voice.name}`} aria-pressed={profile.voice === voice.id} disabled={!data.capabilities.settingsWrite || !!busy} onClick={() => { stopAudio(); setProfile(previous => previous && { ...previous, voice: voice.id }); }}><span className="ai-support-voice-avatar"><AudioLines size={20} /></span><strong>{voice.name}</strong>{profile.voice === voice.id && <CheckCircle2 size={16} />}<small>{voice.description || (data.runtime?.engine === 'live' ? 'Röst för GPT-Live' : 'Svenskt röstprov')}</small></button><button type="button" className="ai-support-preview-button" disabled={!data.capabilities.settingsWrite || !previewAvailable || !!previewVoice} aria-describedby={!previewAvailable ? 'ai-support-preview-unavailable' : undefined} aria-label={`Provlyssna på ${voice.name}`} onClick={() => void preview(voice.id)}>{previewVoice === voice.id ? <LoaderCircle size={16} className="spin" /> : <Volume2 size={16} />}Provlyssna</button></div>)}</div>{previewAvailable ? <div className="ai-support-inline-info"><Info size={17} /><span>Röstprovet använder en kort, fast svensk text med vald röst, ton och tempo. Talsyntesen kan låta annorlunda i ett riktigt samtal. Ett prov gör ett API-anrop.</span></div> : <div id="ai-support-preview-unavailable" className="ai-support-inline-info ai-support-live-preview"><Headphones size={17} /><div><strong>Provlyssna i ett testsamtal</strong><p>Separat röstprov finns inte för den aktiva röstmottagaren. Spara röstvalet och prova dialogen.</p><a className="ai-support-button" href="/rosttest" target="_blank" rel="noopener noreferrer">Provlyssna i ett testsamtal<ArrowUpRight size={14} /></a></div></div>}{audioUrl && previewAvailable && <div className="ai-support-audio-controls" role="status"><Headphones size={18} /><span>{audioPlaying ? 'Spelar röstprov' : 'Röstprovet är klart att spela'}</span>{audioPlaying ? <button type="button" onClick={stopAudio}><Square size={15} />Stoppa röstprovet</button> : <button type="button" onClick={() => { void audio.current?.play().then(() => { setAudioPlaying(true); setAudioNeedsGesture(false); }).catch(() => setError('Röstprovet kunde inte spelas upp. Kontrollera enhetens ljudinställningar.')); }}>Spela röstprovet{audioNeedsGesture ? ' här' : ''}</button>}</div>}</section>
          <form className="ai-support-profile" onSubmit={event => { event.preventDefault(); if (profile) void mutate('settings', '/settings', profile, value => { setProfile(value.settings); setProfileBase(JSON.stringify(value.settings)); profileDirtyRef.current = false; }); }}><div className="ai-support-card-title"><Sparkles size={23} /><div><h3>Röst & bemötande</h3><p>Personligt, tydligt och på svenska.</p></div></div><div className="ai-support-inline-info"><ShieldCheck size={17} />Bolagsnamn, hälsning och uttalsanvisningar används i kundsamtal. Granska att texterna får lämnas till kunder innan du sparar.</div><fieldset disabled={!data.capabilities.settingsWrite || !!busy}><label className="ai-support-check enabled"><input type="checkbox" checked={profile.enabled} onChange={event => setProfile({ ...profile, enabled: event.target.checked })} />AI-kundmottagningen är aktiv</label><label>Bolagsnamn<input required maxLength={160} value={profile.companyName} onChange={event => setProfile({ ...profile, companyName: event.target.value })} /></label><label>Hälsningsfras<textarea rows={3} maxLength={500} required value={profile.greeting} onChange={event => setProfile({ ...profile, greeting: event.target.value })} /><small>Kundinformation som du ansvarar för att granska. Används i början av nästa samtal.</small></label><div className="ai-support-field-row"><label>Ton<select value={profile.tone} onChange={event => setProfile({ ...profile, tone: event.target.value as AiSettings['tone'] })}><option value="friendly">Vänlig</option><option value="professional">Professionell</option><option value="calm">Lugn</option></select></label><label>Tempo<select value={profile.pace} onChange={event => setProfile({ ...profile, pace: event.target.value as AiSettings['pace'] })}><option value="slow">Lugnt</option><option value="normal">Normalt</option><option value="brisk">Raskt</option></select></label></div><label>Uttal och förkortningar<textarea rows={4} maxLength={2000} value={profile.pronunciationText} onChange={event => setProfile({ ...profile, pronunciationText: event.target.value })} placeholder="Till exempel: JEROC uttalas Jerock" /><small>En granskad uttalsanvisning per rad. Hälsning och uttal provas i nästa testsamtal.</small></label><footer><span>Gäller nya samtal</span><button type="submit" className="ai-support-button primary">{busy === 'settings' ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}Spara röst & bemötande</button></footer></fieldset></form></div></section>}
      {tab === 'protection' && <section id="ai-support-protection" role="tabpanel" aria-labelledby="ai-tab-protection"><div className="ai-support-protection-hero"><span><ShieldCheck size={34} /></span><div><h3>Trygg hjälp till kunden</h3><p>Kundmottagningen använder godkänd kundinformation. Skyddsgränserna gäller alltid och går inte att stänga av här.</p></div><span className="ai-support-pill published"><LockKeyhole size={13} />Alltid aktiva</span></div><div className="ai-support-protection-grid">{[{ title: 'Godkända fakta', text: 'Endast publicerade och uttryckligen granskade svar för rätt bolag och anläggning får användas. Utkast och arkiverade svar är inte kundunderlag.' }, { title: 'Personal & löner', text: 'HR, löner, scheman och andra personaluppgifter ingår inte i kunskapsunderlaget.' }, { title: 'Bank & lösenord', text: 'Bankuppgifter, inloggningar, API-nycklar och betalningshantering ingår inte i kundmottagningens kunskap.' }, { title: 'Bolagets information', text: 'Information från andra bolag får inte användas. Varje bolag har sin egen kunskapsbank och profil.' }, { title: 'Inga gissningar', text: 'Saknas bekräftade uppgifter ska kundmottagningen säga det och hänvisa frågan till kontoret. Inga påhittade priser eller öppettider.' }, { title: 'Inga automatiska affärshändelser', text: 'Testsamtalet kan inte skapa arbetsordrar, ändra kunder eller genomföra utbetalningar. Uppföljning sker i samtalsloggen.' }].map(item => <article key={item.title}><ShieldCheck size={20} /><h4>{item.title}</h4><p>{item.text}</p></article>)}</div><div className="ai-support-protection-footer"><Headphones size={22} /><div><strong>Prova med era egna frågor</strong><p>Starta ett testsamtal efter att ni har sparat, och kontrollera att svar och bemötande stämmer.</p></div><a className="ai-support-button" href="/rosttest" target="_blank" rel="noopener noreferrer">Testa samtal<ArrowUpRight size={15} /></a></div></section>}
    </>}
    {discardAction && <Modal title="Osparade ändringar" onClose={() => setDiscardAction(null)}><p>Du har ändringar som inte är sparade. Vill du fortsätta redigera eller lämna utan att spara?</p><footer><button className="ai-support-button" onClick={() => setDiscardAction(null)}>Fortsätt redigera</button><button className="ai-support-button primary" onClick={() => { const action = discardAction; discard(); setDiscardAction(null); action(); }}>Lämna utan att spara</button></footer></Modal>}
    {archive && <Modal title="Arkivera svaret?" onClose={() => setArchive(false)}><p><strong>{editor.title}</strong> används inte längre i nya samtal. Tidigare samtalsloggar behålls.</p><footer><button className="ai-support-button" onClick={() => setArchive(false)}>Avbryt</button><button className="ai-support-button danger" disabled={!!busy} onClick={() => { if (editor.id) void mutate('archive', `/knowledge/${encodeURIComponent(editor.id)}/archive`, {}, value => { setArchive(false); putEditor(editorOf(value.knowledge.find(item => item.id === editor.id))); }); }}>Arkivera svar</button></footer></Modal>}
    {importing && <Modal title="Skapa utkast från artikel" onClose={() => setImporting(false)}><p>Välj en aktiv artikel. Namn, beskrivning och vad som ingår blir ett fristående utkast. Priser och intern information följer inte med.</p><label>Artikel<select value={articleId} onChange={event => setArticleId(event.target.value)}><option value="">Välj artikel…</option>{data?.articleCandidates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{data?.articleCandidates.find(item => item.id === articleId) && <div className="ai-support-import-preview"><h3>{data.articleCandidates.find(item => item.id === articleId)?.name}</h3><p>{data.articleCandidates.find(item => item.id === articleId)?.description}</p><p>Utdraget sparas som utkast och kräver din granskning före publicering.</p></div>}<footer><button className="ai-support-button" onClick={() => setImporting(false)}>Avbryt</button><button className="ai-support-button primary" disabled={!articleId || !!busy} onClick={() => void mutate('import', '/knowledge/from-article', { articleId, siteIds: data?.capabilities.globalWrite ? [] : data?.sites.slice(0, 1).map(site => site.id) ?? [] }, value => { setImporting(false); const item = value.knowledge.find(item => item.id === value.saved?.knowledgeId) ?? value.knowledge.filter(item => item.source?.articleId === articleId).at(-1); if (item) putEditor(editorOf(item)); })}>Skapa artikelutkast</button></footer></Modal>}
  </section>;
}
