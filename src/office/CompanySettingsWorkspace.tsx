import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Building2, ChevronRight, FileText, Image, LockKeyhole, MapPin, RefreshCw, Save, Settings2 } from 'lucide-react';
import { OfficePageHeader } from './OfficePageHeader';
import { can, type OfficeUser } from './model';
import AddressField from '../address-assistance/AddressField';
import { companyLookupScope, type CompanyLookupScope } from '../company-register/client';
import { notifyCompanySettingsSaved } from '../company-settings-defaults';
import { normalizePhoneNumber, phoneNumberError } from '../data-format';
import { CompanySettingsError, companyLogoUrl, companySettingsApi } from './company-settings/client';
import type { CompanyNotifications, CompanyProfile, CompanySettings, CompanySettingsDraft } from './company-settings/types';
import './environment.css';
import './customer.css';
import './company-settings/company-settings.css';

export interface CompanySettingsWorkspaceProps {
  user: OfficeUser;
  actualUser: OfficeUser;
  onNotice(message: string): void;
  onProfileChanged?(settings: CompanySettings): void;
}
const tabs = [['company', 'Företaget', Building2], ['documents', 'Logga & dokument', Image], ['defaults', 'Standardval', Settings2], ['notifications', 'Aviseringar', Bell]] as const;
type Tab = typeof tabs[number][0];
type RecipientText = Record<keyof CompanyNotifications, string>;
const draftOf = (settings: CompanySettings): CompanySettingsDraft => structuredClone({ profile: settings.profile, documents: settings.documents, defaults: settings.defaults, notifications: settings.notifications });
const recipientTextOf = (settings: CompanySettingsDraft): RecipientText => ({ customerInquiries: settings.notifications.customerInquiries.join('\n'), bookings: settings.notifications.bookings.join('\n'), integrationErrors: settings.notifications.integrationErrors.join('\n'), weighedDocumentEmail: settings.notifications.weighedDocumentEmail.recipients.join('\n') });
const recipients = (text: string) => [...new Set(text.split(/[\n,;]/).map(value => value.trim()).filter(Boolean))];
const mayRead = (user: OfficeUser) => user.active !== false && (['VD', 'Systemadmin'].includes(user.level) || user.permissions.some(value => ['companySettingsRead', 'companySettingsWrite'].includes(value)));
const mayManage = (user: OfficeUser) => user.active !== false && !user.siteIds && (['VD', 'Systemadmin'].includes(user.level) || user.permissions.some(value => value === 'companySettingsWrite'));

/** Company settings use the same office shell, tabs, form grids and panels as the existing workspaces. */
export default function CompanySettingsWorkspace(props: CompanySettingsWorkspaceProps) {
  const scope = companyLookupScope({ 'X-Demo-Actor': props.actualUser.id, 'X-Demo-User': props.user.id });
  const identity = JSON.stringify([scope.key, props.actualUser.level, props.actualUser.permissions, props.actualUser.siteIds, props.user.level, props.user.permissions, props.user.siteIds]);
  if (![props.actualUser, props.user].every(mayRead)) return <section className="office-panel"><p>Du saknar behörighet att visa företagsinställningar.</p></section>;
  return <CompanySettingsEditor key={identity} {...props} scope={scope} mayManage={[props.actualUser, props.user].every(mayManage)} />;
}

function CompanySettingsEditor({ user, actualUser, onNotice, onProfileChanged, scope, mayManage: managementAllowed }: CompanySettingsWorkspaceProps & { scope: CompanyLookupScope; mayManage: boolean }) {
  const formId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const operationAbort = useRef<AbortController | null>(null);
  const [settings, setSettings] = useState<CompanySettings>();
  const [draft, setDraft] = useState<CompanySettingsDraft>();
  const [recipientText, setRecipientText] = useState<RecipientText>({ customerInquiries: '', bookings: '', integrationErrors: '', weighedDocumentEmail: '' });
  const [tab, setTab] = useState<Tab>('company');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [retry, setRetry] = useState(0);
  const effectiveDraft = draft && { ...draft, notifications: {
    customerInquiries: recipients(recipientText.customerInquiries), bookings: recipients(recipientText.bookings), integrationErrors: recipients(recipientText.integrationErrors),
    weighedDocumentEmail: { ...draft.notifications.weighedDocumentEmail, recipients: recipients(recipientText.weighedDocumentEmail) },
  } };
  const dirty = Boolean(settings && effectiveDraft && JSON.stringify(draftOf(settings)) !== JSON.stringify(effectiveDraft));
  const editable = managementAllowed && settings?.capabilities.canManage === true;
  const disabled = !editable || busy || uploading || conflict;

  function adopt(value: CompanySettings) {
    setSettings(value); setDraft(draftOf(value)); setRecipientText(recipientTextOf(value)); setError(''); setConflict(false);
  }
  function current(number: number) { return mounted.current && requestSequence.current === number && scope.platformKey === companyLookupScope().platformKey; }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const number = ++requestSequence.current;
    setLoading(true); setError('');
    void companySettingsApi.read(scope, controller.signal).then(value => {
      if (current(number)) adopt(value);
    }).catch(failure => { if (current(number) && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Företagsinställningarna kunde inte hämtas.'); })
      .finally(() => { if (current(number)) setLoading(false); });
    return () => { mounted.current = false; requestSequence.current++; controller.abort(); operationAbort.current?.abort(); };
    // Scope changes remount this editor, so unsaved data never moves between companies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    const beforeNavigation = (event: Event) => {
      if ((busy || uploading) || dirty && !window.confirm('Du har osparade företagsinställningar. Vill du lämna sidan?')) event.preventDefault();
    };
    window.addEventListener('scrappilot:before-company-settings-navigation', beforeNavigation);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('scrappilot:before-company-settings-navigation', beforeNavigation); };
  }, [dirty, busy, uploading]);

  const changeProfile = (fields: Partial<CompanyProfile>) => { setDraft(value => value && { ...value, profile: { ...value.profile, ...fields } }); setError(''); };
  const changeDocuments = (fields: Partial<CompanySettingsDraft['documents']>) => { setDraft(value => value && { ...value, documents: { ...value.documents, ...fields } }); setError(''); };
  function reset() {
    if (settings && !busy && !uploading) adopt(settings);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings || !effectiveDraft || !editable || busy || uploading || conflict || !dirty) return;
    if (!effectiveDraft.profile.name.trim()) { setError('Ange företagets namn.'); return; }
    if (phoneNumberError(effectiveDraft.profile.phone)) { setError('Kontrollera företagets telefonnummer.'); return; }
    const recipientGroups = [effectiveDraft.notifications.customerInquiries, effectiveDraft.notifications.bookings,
      effectiveDraft.notifications.integrationErrors, effectiveDraft.notifications.weighedDocumentEmail.recipients];
    if (effectiveDraft.notifications.weighedDocumentEmail.enabled && !effectiveDraft.notifications.weighedDocumentEmail.recipients.length) {
      setError('Ange minst en mottagare för vägt underlag.'); return;
    }
    const emails = [effectiveDraft.profile.email, effectiveDraft.profile.invoiceEmail, ...recipientGroups.flat()].filter(Boolean);
    if (emails.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))) { setError('Kontrollera e-postadresserna. Ange en giltig adress per rad i aviseringarna.'); return; }
    if (recipientGroups.some(values => values.length > 10)) { setError('Ange högst tio mottagare per avisering.'); return; }
    const number = ++requestSequence.current;
    operationAbort.current?.abort();
    const controller = new AbortController(); operationAbort.current = controller;
    setBusy(true); setError('');
    try {
      const saved = await companySettingsApi.save({ expectedVersion: settings.version, ...effectiveDraft,
        profile: { ...effectiveDraft.profile, phone: normalizePhoneNumber(effectiveDraft.profile.phone) } }, scope, controller.signal);
      if (!current(number) || controller.signal.aborted) return;
      adopt(saved); notifyCompanySettingsSaved(saved.companyId); onProfileChanged?.(saved); onNotice('Företagsinställningarna är sparade. Nya underlag använder de uppdaterade uppgifterna.');
    } catch (failure) {
      if (!current(number) || controller.signal.aborted) return;
      if (failure instanceof CompanySettingsError && failure.status === 409) { setConflict(true); setError('Inställningarna ändrades av någon annan. Ditt utkast finns kvar. Hämta den senaste versionen innan du sparar.'); }
      else setError(failure instanceof Error ? failure.message : 'Inställningarna kunde inte sparas. Ditt utkast finns kvar.');
    } finally { if (current(number)) setBusy(false); }
  }
  async function uploadLogo(file: File | undefined) {
    if (!file || !editable || busy || uploading || conflict) return;
    const number = ++requestSequence.current;
    operationAbort.current?.abort();
    const controller = new AbortController(); operationAbort.current = controller;
    setUploading(true); setError('');
    try {
      const logo = await companySettingsApi.uploadLogo(file, scope, controller.signal);
      if (!current(number) || controller.signal.aborted) return;
      changeDocuments({ logoId: logo.logoId });
      onNotice('Loggan är uppladdad i utkastet. Spara företagsinställningarna för att börja använda den på nya underlag.');
    } catch (failure) { if (current(number) && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Loggan kunde inte laddas upp.'); }
    finally { if (current(number)) { setUploading(false); if (fileRef.current) fileRef.current.value = ''; } }
  }
  const links = [
    ...([user, actualUser].every(account => can(account, 'environmentRead')) ? [{ to: '/facilities', text: 'Anläggningar & öppettider', Icon: MapPin }] : []),
    ...([user, actualUser].every(account => can(account, 'integrationsRead')) ? [{ to: '/integrations?service=bank', text: 'Bank & bokföring', Icon: Settings2 }, { to: '/integrations?service=microsoft365', text: 'Mejlanslutningar', Icon: Bell }] : []),
    ...([user, actualUser].every(account => can(account, 'users')) ? [{ to: '/personnel/accounts', text: 'Användare & behörigheter', Icon: LockKeyhole }] : []),
  ];
  const leave = () => window.dispatchEvent(new Event('scrappilot:before-company-settings-navigation', { cancelable: true }));

  return <section className="office-customers company-settings-workspace">
    <OfficePageHeader controls={<nav className="customer-tabs" role="tablist" aria-label="Företagsinställningarnas flikar">{tabs.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} aria-controls={`${formId}-${value}`} className={tab === value ? 'active' : ''} disabled={busy || uploading} onClick={() => setTab(value)}>{label}</button>)}</nav>}>
      <div className="office-title"><div><span className="office-eyebrow">FÖRETAGETS INSTÄLLNINGAR</span><h1>Företagsinställningar</h1><p>Gemensamma uppgifter för hela företaget. Lokala uppgifter hanteras per anläggning.</p></div>
        {settings && editable && <div className="company-settings-title-actions"><button type="button" className="office-btn outline" disabled={!dirty || busy || uploading} onClick={reset}>Avbryt</button><button form={formId} type="submit" className="office-btn" disabled={!dirty || busy || uploading || conflict}><Save size={15} />{busy ? 'Sparar…' : 'Spara ändringar'}</button></div>}
      </div>
    </OfficePageHeader>
    {loading ? <div className="office-panel" role="status">Hämtar företagsinställningar…</div> : !settings || !draft ? <div className="office-panel environment-error" role="alert"><span>{error || 'Inställningarna kunde inte hämtas.'}</span><button type="button" className="office-btn outline" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Försök igen</button></div> : <>
      {!editable && <div className="environment-info"><LockKeyhole size={15} /><span>Du kan läsa företagsuppgifterna. VD eller en behörig administratör kan ändra dem.</span></div>}
      {error && <div className="environment-error" role="alert"><span>{error}</span>{conflict && <button type="button" className="office-btn outline" disabled={busy || uploading} onClick={() => { if (!dirty || window.confirm('Hämta den senaste versionen och ersätta ditt osparade utkast?')) setRetry(value => value + 1); }}>Hämta senaste version</button>}</div>}
      <div className="company-settings-layout">
        <form id={formId} onSubmit={save} className="company-settings-main" aria-label="Företagsinställningar">
          <section id={`${formId}-${tab}`} className="office-panel environment-panel" role="tabpanel" aria-label={tabs.find(([value]) => value === tab)?.[1]}>
            <fieldset disabled={disabled}>
              {tab === 'company' && <>
                <header className="environment-heading"><span className="environment-icon"><Building2 size={20} /></span><div><h2>Företagsuppgifter</h2><p>Kontaktuppgifter och postadress som används på nya underlag.</p></div></header>
                <div className="environment-form-grid">
                  <label>Företagsnamn<input aria-label="Företagsnamn" value={draft.profile.name} required maxLength={200} onChange={event => changeProfile({ name: event.target.value })} /></label>
                  <label>Organisationsnummer<input aria-label="Organisationsnummer" value={settings.organisationNumber} readOnly disabled /><small className="company-settings-readonly"><LockKeyhole size={11} />Bolagets juridiska identitet ändras inte här.</small></label>
                  <label className="environment-full">Postadress<AddressField aria-label="Postadress" autoComplete="street-address" value={{ address: draft.profile.address, postalCode: draft.profile.postalCode, city: draft.profile.city, countryCode: 'SE' }} scopeKey={`company-profile:${settings.companyId}`} disabled={disabled} requestHeaders={scope.headers} maxLength={300} onChange={address => changeProfile({ address })} onApply={address => changeProfile({ address: address.address, postalCode: address.postalCode, city: address.city })} /></label>
                  <label>Postnummer<input aria-label="Postnummer" inputMode="numeric" autoComplete="postal-code" value={draft.profile.postalCode} maxLength={6} onChange={event => changeProfile({ postalCode: event.target.value })} /></label>
                  <label>Ort<input aria-label="Ort" autoComplete="address-level2" value={draft.profile.city} maxLength={150} onChange={event => changeProfile({ city: event.target.value })} /></label>
                  <label className="environment-full">Webbplats<input aria-label="Webbplats" type="url" placeholder="https://exempel.se" value={draft.profile.website} maxLength={300} onChange={event => changeProfile({ website: event.target.value })} /></label>
                </div>
                <div className="company-settings-section"><h3>Kontaktuppgifter</h3><div className="environment-form-grid">
                  <label>Telefon<input aria-label="Telefon" type="tel" value={draft.profile.phone} maxLength={40} onChange={event => changeProfile({ phone: event.target.value })} /></label>
                  <label>E-post till kunder<input aria-label="E-post till kunder" type="email" value={draft.profile.email} maxLength={254} onChange={event => changeProfile({ email: event.target.value })} /></label>
                  <label>Fakturamejl<input aria-label="Fakturamejl" type="email" value={draft.profile.invoiceEmail} maxLength={254} onChange={event => changeProfile({ invoiceEmail: event.target.value })} /></label>
                  <label>Kontaktperson<input aria-label="Kontaktperson" value={draft.profile.contactPerson} maxLength={150} onChange={event => changeProfile({ contactPerson: event.target.value })} /></label>
                </div></div>
              </>}
              {tab === 'documents' && <>
                <header className="environment-heading"><span className="environment-icon"><Image size={20} /></span><div><h2>Logga & dokument</h2><p>Företagets profil på nya underlag. Tidigare låsta dokument behåller sina uppgifter.</p></div></header>
                <div className="company-settings-logo">{draft.documents.logoId ? <img src={companyLogoUrl(draft.documents.logoId)} alt="Företagets logga" /> : <span className="environment-muted">Ingen företagslogga uppladdad</span>}</div>
                {editable && <div className="company-settings-upload"><label htmlFor={`${formId}-logo`}>Ladda upp logga<input ref={fileRef} id={`${formId}-logo`} type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={event => { void uploadLogo(event.target.files?.[0]); }} /></label>{draft.documents.logoId && <button className="office-btn outline" type="button" disabled={disabled} onClick={() => changeDocuments({ logoId: undefined })}>Ta bort logga</button>}</div>}
                <p className="environment-muted">PNG, JPG eller WebP, högst 1 MB. Spara ändringarna för att börja använda en uppladdad logga.</p>
                {uploading && <p role="status">Laddar upp loggan…</p>}
                <div className="environment-form-grid"><label className="environment-full">Sidfot på nya dokument<textarea aria-label="Sidfot på nya dokument" value={draft.documents.footerText} maxLength={500} rows={4} onChange={event => changeDocuments({ footerText: event.target.value })} /><small>Exempelvis kontaktuppgifter eller en kort informationstext. Tidigare låsta underlag ändras inte.</small></label></div>
              </>}
              {tab === 'defaults' && <>
                <header className="environment-heading"><span className="environment-icon"><Settings2 size={20} /></span><div><h2>Standardval</h2><p>Förval för nya kunduppgifter. Befintliga kunder och låsta underlag ändras inte.</p></div></header>
                <div className="environment-form-grid"><label>Betalningsvillkor för nya kunder<select aria-label="Betalningsvillkor för nya kunder" value={draft.defaults.paymentTermsDays === null ? '' : String(draft.defaults.paymentTermsDays)} onChange={event => setDraft(value => value && { ...value, defaults: { paymentTermsDays: event.target.value === '' ? null : Number(event.target.value) } })}><option value="">Använd ekonomiintegrationens standard</option>{[...new Set([0, 10, 15, 20, 30, 45, 60, 90, ...(draft.defaults.paymentTermsDays === null ? [] : [draft.defaults.paymentTermsDays])])].sort((a, b) => a - b).map(days => <option key={days} value={days}>{days === 0 ? 'Omgående' : `${days} dagar`}</option>)}</select><small>Kan ändras på den enskilda kunden.</small></label>
                  <label>Språk<input aria-label="Språk" value="Svenska" readOnly disabled /></label><label>Valuta<input aria-label="Valuta" value="SEK" readOnly disabled /></label><label>Tidszon<input aria-label="Tidszon" value="Europe/Stockholm" readOnly disabled /></label>
                </div>
              </>}
              {tab === 'notifications' && <>
                <header className="environment-heading"><span className="environment-icon"><Bell size={20} /></span><div><h2>Aviseringar</h2><p>Företagets mottagarlistor. Ange en adress per rad, högst tio per kategori.</p></div></header>
                <div className="company-settings-section">
                  <label className="company-settings-checkbox"><input type="checkbox" aria-label="Skicka vägt underlag till e-post" checked={draft.notifications.weighedDocumentEmail.enabled}
                    onChange={event => { const enabled = event.target.checked; setDraft(value => value && { ...value, notifications: { ...value.notifications, weighedDocumentEmail: { ...value.notifications.weighedDocumentEmail, enabled } } }); setError(''); }} />Skicka vägt underlag till e-post</label>
                  <p className="environment-muted">Skickar en PDF-kopia till kontoret efter attest. Avser nya attesterade underlag.</p>
                  <div className="environment-form-grid"><label className="environment-full">Mottagare av vägt underlag<textarea aria-label="Vägt underlag – mottagare" value={recipientText.weighedDocumentEmail} disabled={disabled || !draft.notifications.weighedDocumentEmail.enabled}
                    rows={2} maxLength={3000} placeholder="kontor@exempel.se" onChange={event => { setRecipientText(value => ({ ...value, weighedDocumentEmail: event.target.value })); setError(''); }} /><small>Ange minst en adress när utskicket är på. En adress per rad, högst tio mottagare.</small></label></div>
                </div>
                <div className="environment-info">Övriga mottagarlistor används av de aviseringsflöden som är anslutna. Listorna nedan aktiverar inget nytt utskick.</div>
                <div className="environment-form-grid company-settings-section">{([
                  ['customerInquiries', 'Kundförfrågningar'], ['bookings', 'Bokningar'], ['integrationErrors', 'Integrationsfel'],
                ] as const).map(([key, label]) => <label key={key} className="environment-full">{label}<textarea aria-label={`${label} – mottagare`} value={recipientText[key]} rows={3} maxLength={3000} placeholder="namn@exempel.se" onChange={event => { setRecipientText(value => ({ ...value, [key]: event.target.value })); setError(''); }} /></label>)}</div>
              </>}
            </fieldset>
          </section>
          <div className="environment-actions company-settings-actions"><small>{dirty ? 'Du har osparade ändringar.' : 'Inställningarna gäller hela företaget.'}{settings.updatedAt && ` Senast sparat ${new Date(settings.updatedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}.`}</small></div>
        </form>
        <aside className="company-settings-side">
          <section className="office-panel environment-panel" aria-label="Förhandsvisning av nytt underlag"><header className="environment-heading"><span className="environment-icon"><FileText size={20} /></span><div><h2>Förhandsvisning</h2><p>Illustration av företagets uppgifter på ett nytt underlag.</p></div></header>
            <div className="company-settings-preview"><header><div>{draft.documents.logoId && <img src={companyLogoUrl(draft.documents.logoId)} alt="Logga i dokumentförhandsvisning" />}<strong>{draft.profile.name}</strong><small>{draft.profile.address}</small><small>{draft.profile.postalCode} {draft.profile.city}</small></div><h3>AVRÄKNING</h3></header>
              <small>Organisationsnummer {settings.organisationNumber}</small><table><thead><tr><th>Beskrivning</th><th>Vikt</th><th>Belopp</th></tr></thead><tbody><tr><td>Exempelmaterial</td><td>100 kg</td><td>1 000 kr</td></tr></tbody></table><footer>{draft.documents.footerText || [draft.profile.phone, draft.profile.email, draft.profile.website].filter(Boolean).join(' · ')}</footer></div>
            <p className="environment-muted">Ändringar gäller nya underlag. Förhandsvisningen sparar eller ändrar inget dokument.</p>
          </section>
          {links.length > 0 && <section className="office-panel environment-panel"><header className="environment-heading"><span className="environment-icon"><MapPin size={20} /></span><div><h2>Relaterade inställningar</h2><p>Öppettider och lokala kontaktuppgifter finns under respektive anläggning.</p></div></header><div className="company-settings-links">{links.map(({ to, text, Icon }) => <Link key={to} className="office-link" to={to} onClick={event => { if (!leave()) event.preventDefault(); }}><span><Icon size={14} /> {text}</span><ChevronRight size={14} /></Link>)}</div></section>}
        </aside>
      </div>
    </>}
  </section>;
}
