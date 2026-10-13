import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, CircleAlert, ExternalLink, FlaskConical, Landmark, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import type { OfficeUser } from './model';
import { environmentTime } from './environment-types';
import BankConnectionCheckDialog, { bankCheckResult, type BankCheckState } from './BankConnectionCheckDialog';
import BankConsentDiagnostics from './BankConsentDiagnostics';
import { OfficePageHeader } from './OfficePageHeader';
import { bankAccountLabel, bankConsentActionLabel, bankConsentLabel, bankDiagnosticValue, bankIntegrationApi, type BankAccountsResult, type BankBalancesResult, type BankConnectionResult, type BankDefinition, type BankIntegrationState } from './bank-integration-client';
import { bankAuthorizationUrl } from './OpenPaymentsIntegrationPanel';
import { useBankIntegrationAction } from './useBankIntegrationAction';
import './environment.css';
import './bank-integration.css';

type Projection = { state: BankIntegrationState; banks?: BankDefinition[]; accounts?: BankAccountsResult; balances?: BankBalancesResult; test?: BankConnectionResult };

export default function BankSandboxWorkspace({ user, actualUser }: { user: OfficeUser; actualUser: OfficeUser; onNotice?: (message: string) => void }) {
  const { scope, permitted, matching, loading: sessionLoading, sessionError, refreshSession, pending, pendingReads, error, run, runRead } = useBankIntegrationAction(user, actualUser);
  const [search] = useSearchParams();
  const bankAuth = search.get('bankAuth') ?? new URLSearchParams(window.location.search).get('bankAuth');
  const [stored, setStored] = useState<{ scope: string; value: Projection }>();
  const [dialog, setDialog] = useState<BankCheckState>();
  const testButton = useRef<HTMLButtonElement>(null);
  const value = stored?.scope === scope ? stored.value : undefined;
  const visibleDialog = dialog?.scope === scope ? dialog : undefined;
  const load = useCallback(() => run('load', async (signal, current) => {
    const state = await bankIntegrationApi.settings(signal);
    if (current()) setStored({ scope, value: { state, test: state.lastTest ?? undefined } });
  }), [scope, run]);
  useEffect(() => { if (permitted && matching) void load(); }, [permitted, matching, load]);
  function apply(patch: Partial<Projection>) { setStored(previous => previous?.scope === scope ? { scope, value: { ...previous.value, ...patch } } : previous); }
  function testConnection() { void run('test', async (signal, current) => {
    setDialog({ scope, progress: { phase: 'running', mode: 'test' } });
    try {
      const result = await bankIntegrationApi.test(signal);
      if (!current()) return;
      apply({ test: result }); setDialog(bankCheckResult(scope, result));
    } catch (failure) {
      if (current()) setDialog({ scope, progress: { phase: 'error', mode: 'test', message: failure instanceof Error ? failure.message : 'Testet kunde inte slutföras.' } });
      throw failure;
    }
  }); }
  function banks() { void runRead('banks', async (signal, current) => { const result = await bankIntegrationApi.banks(signal); if (current()) apply({ banks: result.banks }); }); }
  function accounts() { void run('accounts', async (signal, current) => { const result = await bankIntegrationApi.accounts(signal); if (current()) apply({ accounts: result }); }); }
  function balances() { void run('balances', async (signal, current) => { const result = await bankIntegrationApi.balances(signal); if (current()) apply({ balances: result }); }); }
  function connect() { void run('consent', async (signal, current) => { const consent = await bankIntegrationApi.consent(signal); if (current() && value) apply({ state: { ...value.state, consent, accounts: [] }, accounts: undefined, balances: undefined }); }); }
  function showTest() { if (value?.test) setDialog(bankCheckResult(scope, value.test)); }
  // This button re-reads the stored result. It never sends another payment or test.
  function readHistory() { void run('history', async (signal, current) => {
    const state = await bankIntegrationApi.settings(signal);
    if (!current()) return;
    apply({ state, test: state.lastTest ?? value?.test, accounts: undefined, balances: undefined });
    if (state.lastTest) setDialog(bankCheckResult(scope, state.lastTest));
  }); }
  if (!permitted) return <div className="office-panel integration-message"><ShieldCheck size={19} /><span>Du behöver behörighet att hantera bolagets integrationer för att köra banktest.</span></div>;
  const consent = value?.accounts?.consent ?? value?.state.consent;
  const authorisationUrl = bankAuthorizationUrl(consent?.authorisationUrl);
  const receivedAccounts = value?.accounts?.accounts ?? value?.state.accounts ?? [];
  const ready = !!value?.state.configuration.ready;
  return <section className="bank-sandbox-workspace">
    <OfficePageHeader><Link className="office-link integration-back" to="/integrations?service=bank"><ArrowLeft size={15} />Till bankinställningar</Link><div className="office-title"><div><span className="office-eyebrow">INTEGRATIONSTEST · OPEN PAYMENTS</span><h1>Prova bankanslutningen</h1><p>Kontrollera åtkomst, testbanker, bankmedgivande och konton.</p></div><span className="integration-status test"><FlaskConical size={14} />BANK · SANDBOX</span></div></OfficePageHeader>
    <div className="bank-test-note"><ShieldCheck size={18} /><div><strong>Fristående anslutningsprov</strong><p>Inga betalningar skickas från denna sida och inga fakturor ändras i Spiris. Bankbetalningar provas från ett färdigt viktkort. Konton och saldon här hör till bankens testmiljö.</p></div></div>
    {bankAuth && <div className={`bank-feedback ${bankAuth === 'ok' ? '' : 'warning'}`} role="status"><ShieldCheck size={17} /><span>{bankAuth === 'ok' ? 'Tillbaka från testbanken. Hämta konton för att kontrollera bankens godkännande.' : 'Bankens godkännande kunde inte slutföras. Kontrollera medgivandet eller försök ansluta banken igen.'}</span></div>}
    {!matching && <div className="bank-feedback" role={sessionError ? 'alert' : 'status'}><span>{sessionError || 'Hämtar bolagets anslutning…'}</span>{!sessionLoading && <button className="office-btn outline" onClick={() => void refreshSession().catch(() => undefined)}>Försök igen</button>}</div>}
    {matching && error && <div className="bank-feedback error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {matching && <div className="bank-sandbox-layout"><article className="office-panel"><h2>Anslutning och testbanker</h2>
      {!value && <p role="status">{pending ? 'Hämtar bankinställningar…' : 'Inställningarna kunde inte hämtas.'}{!pending && <button className="office-btn outline" onClick={() => void load()}>Försök igen</button>}</p>}
      {value && !ready && <div className="bank-feedback warning"><CircleAlert size={17} /><div><strong>Serverns anslutning är inte klar</strong><ul>{[...value.state.configuration.missing, ...value.state.configuration.issues].map((item, index) => <li key={`${index}/${item}`}>{item}</li>)}</ul></div></div>}
      <p>Testet kontrollerar autentisering och hämtar banklistan från Open Payments. Ett lyckat prov bekräftar anslutningen; bankens medgivande och betalningens slutresultat kontrolleras separat.</p>
      <div className="bank-sandbox-toolbar"><button ref={testButton} className="office-btn" disabled={!!pending || !value} onClick={testConnection}>{pending === 'test' ? <LoaderCircle size={15} className="bank-spin" /> : <ShieldCheck size={15} />}{pending === 'test' ? 'Testar anslutning…' : 'Testa anslutningen'}</button><button className="office-btn outline" disabled={pendingReads.includes('banks') || !ready} onClick={banks}>{pendingReads.includes('banks') ? <LoaderCircle size={15} className="bank-spin" /> : <RefreshCw size={15} />}{pendingReads.includes('banks') ? 'Hämtar testbanker…' : 'Hämta testbanker'}</button></div>
      {value?.test && <div className="bank-journal"><p className="bank-test-status">{value.test.ok ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}{value.test.ok ? 'Anslutningen är verifierad' : 'Anslutningen kunde inte verifieras'}{value.test.bankCount != null ? ` · ${value.test.bankCount} testbanker` : ''}</p>{value.test.checkedAt && <p>Kontrollerad {environmentTime(value.test.checkedAt)}</p>}<button className="office-link" onClick={showTest}>Visa skickat och mottaget</button></div>}
      {value?.banks && <ul className="bank-journal">{value.banks.map(bank => <li key={bank.id}><strong>{bank.name}</strong>{bank.countryCode && <small>{bank.countryCode}</small>}{bank.paymentProducts?.length ? <small className="bank-capabilities">Betalningstyper: {bank.paymentProducts.join(', ')}</small> : null}</li>)}</ul>}
    </article><article className="office-panel"><h2>Bankmedgivande och konton</h2><p>{bankConsentLabel(consent)}. Välj bank och testidentiteter i bankinställningarna först.</p><BankConsentDiagnostics consent={consent} />
      <div className="bank-sandbox-toolbar"><button className="office-btn outline" disabled={!!pending || !ready || !value?.state.settings.bankId} onClick={connect}><Landmark size={15} />{bankConsentActionLabel(consent)}</button>{authorisationUrl && <a className="office-btn" href={authorisationUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Godkänn hos testbanken</a>}<button className="office-btn outline" disabled={!!pending || !consent} onClick={accounts}><RefreshCw size={15} />Hämta konton</button></div>
      {receivedAccounts.length > 0 && <ul className="bank-account-list">{receivedAccounts.map(account => <li key={account.id}>{bankAccountLabel(account)}{account.id === value?.state.settings.debtorAccountId && <strong> · Valt utbetalningskonto</strong>}</li>)}</ul>}
      {value?.accounts && !receivedAccounts.length && <p>Inga konton har lämnats ut. Kontrollera att bankens medgivande är klart.</p>}
      <Link className="office-link" to="/integrations?service=bank">Välj utbetalningskonto i bankinställningarna</Link>
      <section className="bank-settings-section"><div className="bank-field-heading"><h3>Testkontots saldo</h3><button className="office-link" disabled={!!pending || !value?.state.settings.debtorAccountId || !consent} onClick={balances}><RefreshCw size={14} />Hämta testsaldo</button></div><p>Saldot visas endast när testbanken har lämnat ut det för det valda kontot.</p>{value?.balances?.error && <div className="bank-feedback warning" role="alert"><CircleAlert size={16} /><span>{value.balances.error.message}</span></div>}{value?.balances && value.balances.data != null && <pre>{JSON.stringify(bankDiagnosticValue(value.balances.data), null, 2)}</pre>}</section>
    </article></div>}
    {visibleDialog && matching && <BankConnectionCheckDialog check={visibleDialog} onClose={() => setDialog(undefined)} onReadHistory={readHistory} returnFocus={testButton} />}
  </section>;
}
