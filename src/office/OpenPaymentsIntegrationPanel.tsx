import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, CircleAlert, ExternalLink, FlaskConical, Landmark, LoaderCircle, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import type { OfficeUser } from './model';
import { clearIntegrationReadCache } from './integration-read-cache';
import { bankAccountLabel, bankConsentLabel, bankIntegrationApi, type BankAccountsResult, type BankBookkeepingChoices, type BankDefinition, type BankIntegrationState, type BankSettingsInput } from './bank-integration-client';
import { useBankIntegrationAction } from './useBankIntegrationAction';
import './bank-integration.css';

type Projection = { state: BankIntegrationState; form: BankSettingsInput; banks: BankDefinition[]; choices?: BankBookkeepingChoices; accounts?: BankAccountsResult; dirty: boolean };
const formFrom = ({ settings }: BankIntegrationState): BankSettingsInput => ({ enabled: settings.enabled, bankId: settings.bankId ?? null,
  corporateId: settings.corporateId ?? (settings.revision === 0 ? '5560160680' : null), psuId: settings.psuId ?? (settings.revision === 0 ? '199002092386' : null), debtorAccountId: settings.debtorAccountId ?? null,
  bookkeepingEnabled: settings.bookkeepingEnabled, spirisCompanyId: settings.spirisCompanyId ?? null, spirisBankAccountId: settings.spirisBankAccountId ?? null });
export const bankAuthorizationUrl = (value?: string | null) => {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};

export default function OpenPaymentsIntegrationPanel({ user, actualUser, onNotice }: { user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void }) {
  const { scope, permitted, matching, loading: sessionLoading, error: sessionError, refreshSession, pending, error, run } = useBankIntegrationAction(user, actualUser);
  const [stored, setStored] = useState<{ scope: string; value: Projection }>();
  const value = stored?.scope === scope ? stored.value : undefined;
  const load = useCallback(() => run('load', async (signal, current) => {
    const state = await bankIntegrationApi.settings(signal);
    if (!current()) return;
    setStored({ scope, value: { state, form: formFrom(state), banks: [], dirty: false } });
    if (!state.configuration.ready) return;
    const list = await bankIntegrationApi.banks(signal);
    if (current()) setStored(previous => previous?.scope === scope ? { scope, value: { ...previous.value, banks: list.banks } } : previous);
  }), [run, scope]);
  useEffect(() => { if (permitted && matching) void load(); }, [permitted, matching, load]);
  function change(patch: Partial<BankSettingsInput>) { setStored(previous => previous?.scope === scope ? { scope, value: { ...previous.value, form: { ...previous.value.form, ...patch }, dirty: true } } : previous); }
  function save() {
    if (!value) return;
    const submitted = structuredClone(value.form); onNotice('');
    void run('save', async (signal, current) => {
      const state = await bankIntegrationApi.saveSettings(submitted, signal);
      if (!current()) return;
      setStored(previous => previous?.scope === scope ? { scope, value: { ...previous.value, state, form: formFrom(state), accounts: undefined, dirty: false } } : previous);
      clearIntegrationReadCache('catalog'); onNotice('Bankinställningarna är sparade för bolaget.');
    });
  }
  function banks() { void run('banks', async (signal, current) => { const list = await bankIntegrationApi.banks(signal); if (current()) setStored(previous => previous?.scope === scope ? { scope, value: { ...previous.value, banks: list.banks } } : previous); }); }
  function choices() { void run('choices', async (signal, current) => { const choices = await bankIntegrationApi.choices(signal); if (current()) setStored(previous => previous?.scope === scope ? { scope, value: { ...previous.value, choices } } : previous); }); }
  function accounts() { void run('accounts', async (signal, current) => { const accounts = await bankIntegrationApi.accounts(signal); if (current()) setStored(previous => previous?.scope === scope ? { scope, value: { ...previous.value, accounts } } : previous); }); }
  function connect() { void run('consent', async (signal, current) => { const consent = await bankIntegrationApi.consent(signal); if (current()) setStored(previous => previous?.scope === scope ? { scope, value: { ...previous.value, accounts: undefined, state: { ...previous.value.state, consent, accounts: [] } } } : previous); }); }

  if (!permitted) return <div className="office-panel integration-message"><ShieldCheck size={19} /><span>Du behöver behörighet att hantera bolagets integrationer för att visa bankinställningarna.</span></div>;
  if (!matching) return <div className="office-panel integration-message" role={sessionError ? 'alert' : 'status'}><ShieldCheck size={19} /><span>{sessionError || 'Hämtar bolagets anslutning…'}</span>{!sessionLoading && <button className="office-btn outline" onClick={() => void refreshSession().catch(() => undefined)}>Försök igen</button>}</div>;
  const disabled = !!pending || !value;
  const bankAccounts = value?.accounts?.accounts ?? value?.state.accounts ?? [];
  const consent = value?.accounts?.consent ?? value?.state.consent;
  const authorisationUrl = bankAuthorizationUrl(consent?.authorisationUrl);
  const spirisAccounts = value?.choices?.bankAccounts.filter(account => account.active !== false && (!account.currency || account.currency === 'SEK')) ?? [];
  const savedSpiris = value?.form.spirisBankAccountId && !spirisAccounts.some(account => account.id === value.form.spirisBankAccountId);
  const savedBank = value?.form.bankId && !value.banks.some(bank => bank.id === value.form.bankId);
  const savedAccount = value?.form.debtorAccountId && !bankAccounts.some(account => account.id === value.form.debtorAccountId);
  return <article className="office-panel bank-integration-panel">
    <div className="bank-section-heading"><span className="bank-section-icon"><Landmark size={25} /></span><div><h2>Bank · Open Payments</h2><p>Bankbetalningar och kontoinformation för bolaget.</p></div><span className="integration-status test"><FlaskConical size={13} />SANDBOX</span></div>
    <div className="bank-test-note"><ShieldCheck size={18} /><div><strong>Bankernas testmiljö</strong><p>Inga riktiga pengar flyttas. Konton, saldon och bankens godkännanden är testuppgifter.</p></div></div>
    {error && <div className="bank-feedback error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {!value && <div className="bank-feedback" role="status">{pending ? <LoaderCircle size={17} className="bank-spin" /> : <RefreshCw size={17} />}<span>{pending ? 'Hämtar bankinställningar…' : 'Bankinställningarna kunde inte hämtas.'}</span>{!pending && <button className="office-btn outline" onClick={() => void load()}>Försök igen</button>}</div>}
    {value && <>
      {!value.state.configuration.ready && <div className="bank-feedback warning"><CircleAlert size={17} /><div><strong>Serverns bankanslutning behöver konfigureras</strong><ul>{[...value.state.configuration.missing, ...value.state.configuration.issues].map((issue, index) => <li key={`${index}/${issue}`}>{issue}</li>)}</ul></div></div>}
      {value.state.configuration.redirectUri && <div className="bank-feedback"><ExternalLink size={17} /><div><strong>Returadress i Open Payments</strong><p className="bank-field-help">Lägg till denna exakta adress i portalens Redirect URI whitelist och spara:</p><code className="bank-redirect-uri">{value.state.configuration.redirectUri}</code></div></div>}
      <div className="bank-settings-grid">
        <label><span className="bank-field-heading">Bank i testmiljön<button type="button" className="office-link" disabled={disabled || !value.state.configuration.ready} onClick={banks}><RefreshCw size={14} />Hämta testbanker</button></span><select aria-label="Bank i testmiljön" value={value.form.bankId ?? ''} disabled={disabled} onChange={event => change({ bankId: event.target.value || null, debtorAccountId: null })}><option value="">Välj en testbank</option>{savedBank && <option value={value.form.bankId ?? ''}>Tidigare vald bank · hämta för att kontrollera</option>}{value.banks.map(bank => <option key={bank.id} value={bank.id}>{bank.name}{bank.countryCode ? ` · ${bank.countryCode}` : ''}</option>)}</select></label>
        <label>Företags-ID hos testbanken<input value={value.form.corporateId ?? ''} disabled={disabled} onChange={event => change({ corporateId: event.target.value || null })} autoComplete="off" /><small>En testidentitet för bolaget. Det förifyllda värdet kommer från Open Payments sandboxexempel.</small></label>
        <label>Användar-ID hos testbanken<input value={value.form.psuId ?? ''} disabled={disabled} onChange={event => change({ psuId: event.target.value || null })} autoComplete="off" /><small>En testidentitet från sandboxexemplet, inte den inloggade personens personnummer.</small></label>
      </div>
      <section className="bank-settings-section"><div className="bank-field-heading"><h3><Building2 size={17} />Bolagets bankkonto</h3><button className="office-link" disabled={disabled || value.dirty || !consent} onClick={accounts}><RefreshCw size={14} />{pending === 'accounts' ? 'Hämtar…' : 'Hämta konton'}</button></div>
        <p className="bank-field-help">{bankConsentLabel(consent)}. Spara vald bank innan du ansluter den.</p>
        {consent?.error && <div className="bank-feedback warning"><CircleAlert size={16} /><span>{consent.error.message}</span></div>}
        <div className="bank-consent-actions"><button className="office-btn outline" disabled={disabled || value.dirty || !value.form.bankId || !value.state.configuration.ready} onClick={connect}><Landmark size={15} />{pending === 'consent' ? 'Förbereder anslutning…' : consent ? 'Förnya bankmedgivande' : 'Anslut testbanken'}</button>{authorisationUrl && <a className="office-btn" href={authorisationUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Godkänn hos testbanken</a>}</div>
        <label className="bank-field">Konto för utbetalningar<select value={value.form.debtorAccountId ?? ''} disabled={disabled || !bankAccounts.length} onChange={event => change({ debtorAccountId: event.target.value || null })}><option value="">Välj ett konto från banken</option>{savedAccount && <option value={value.form.debtorAccountId ?? ''}>Tidigare valt konto · kontrollera bankmedgivandet</option>}{bankAccounts.filter(account => !account.currency || account.currency === 'SEK').map(account => <option key={account.id} value={account.id}>{bankAccountLabel(account)}</option>)}</select><small>Endast konton som banken har lämnat ut för detta bolag kan väljas.</small></label>
      </section>
      <label className="bank-check"><input type="checkbox" checked={value.form.enabled} disabled={disabled} onChange={event => change({ enabled: event.target.checked })} /><span><strong>Aktivera bankutbetalningar i sandbox</strong><small>Betalningar startas från attesterade viktkort med bokförd leverantörsfaktura. Bankens slutliga bekräftelse krävs innan utbetalningen räknas som genomförd.</small></span></label>
      <section className="bank-settings-section"><h3>Efter bekräftad bankbetalning</h3><label className="bank-check"><input type="checkbox" checked={value.form.bookkeepingEnabled} disabled={disabled} onChange={event => change({ bookkeepingEnabled: event.target.checked })} /><span><strong>Registrera testbetalningen i Spiris sandbox</strong><small>Bankens bekräftelse och Spiris bokföringsresultat sparas som separata händelser.</small></span></label>
        {value.form.bookkeepingEnabled && <><div className="bank-field-heading"><label htmlFor="bank-spiris-account">Betalkonto i Spiris</label><button className="office-link" disabled={disabled} onClick={choices}><RefreshCw size={14} />{pending === 'choices' ? 'Hämtar…' : 'Hämta från Spiris'}</button></div><select id="bank-spiris-account" value={value.form.spirisBankAccountId ?? ''} disabled={disabled} onChange={event => change({ spirisBankAccountId: event.target.value || null, spirisCompanyId: event.target.value ? value.choices?.companyId : null })}><option value="">Välj ett betalkonto från Spiris</option>{savedSpiris && <option value={value.form.spirisBankAccountId ?? ''}>Tidigare valt konto · hämta för att kontrollera</option>}{spirisAccounts.map(account => <option key={account.id} value={account.id}>{account.name}{account.ledgerAccountNumber ? ` · ${account.ledgerAccountNumber}` : ''}</option>)}</select><p className="bank-field-help">Välj bokföringskontot som motsvarar bankkontot ovan{value.choices?.companyName ? ` i ${value.choices.companyName}` : ''}.</p></>}
      </section>
      <div className="bank-panel-actions"><Link className="office-btn outline" to="/integrations/bank-test"><FlaskConical size={15} />Öppna banktestsidan</Link><button className="office-btn" disabled={disabled || !value.dirty} onClick={save}>{pending === 'save' ? <LoaderCircle size={15} className="bank-spin" /> : <Save size={15} />}{pending === 'save' ? 'Sparar…' : 'Spara inställningar'}</button></div>
    </>}
  </article>;
}
