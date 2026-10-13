import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, FlaskConical, LoaderCircle, RefreshCw, Save, ShieldCheck, Smartphone } from 'lucide-react';
import type { OfficeUser } from './model';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { clearIntegrationReadCache } from './integration-read-cache';
import { mayManageSwish, swishIntegrationApi, type SwishBankChoices, type SwishIntegrationState, type SwishSettings } from './swish-integration-client';
import './swish-integration.css';

type SettingsForm = Pick<SwishSettings, 'enabled' | 'bookkeepingEnabled' | 'spirisBankAccountId' | 'spirisCompanyId'>;
const formFrom = (state: SwishIntegrationState): SettingsForm => ({ enabled: state.settings.enabled,
  bookkeepingEnabled: state.settings.bookkeepingEnabled, spirisBankAccountId: state.settings.spirisBankAccountId,
  spirisCompanyId: state.settings.spirisCompanyId });

export default function SwishIntegrationPanel({ user, actualUser, onNotice }: {
  user: OfficeUser; actualUser: OfficeUser; onNotice: (message: string) => void;
}) {
  const { session, loading: sessionLoading, error: sessionError, refreshSession } = useEnvironmentSession();
  const permitted = mayManageSwish(user, actualUser);
  const matching = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const identity = `${actualUser.id}/${actualUser.level}/${actualUser.permissions.join(',')}/${user.id}/${user.level}/${user.permissions.join(',')}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const permittedRef = useRef(false); permittedRef.current = permitted && matching;
  const mounted = useRef(true), generation = useRef(0), busy = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const [state, setState] = useState<SwishIntegrationState>(), [form, setForm] = useState<SettingsForm>();
  const [choices, setChoices] = useState<SwishBankChoices>();
  const [pending, setPending] = useState<'load' | 'save' | 'choices'>(), [error, setError] = useState(''), [dirty, setDirty] = useState(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; for (const c of controllers.current) c.abort(); }; }, []);
  useEffect(() => {
    generation.current++; for (const c of controllers.current) c.abort(); controllers.current.clear(); busy.current = false;
    setState(undefined); setForm(undefined); setChoices(undefined); setPending(undefined); setError(''); setDirty(false);
  }, [identity, matching]);

  const action = useCallback(async (kind: 'load' | 'save' | 'choices', operation: (signal: AbortSignal) => Promise<void>) => {
    if (!permittedRef.current || busy.current) return;
    const controller = new AbortController(); controllers.current.add(controller);
    const request = ++generation.current;
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && permittedRef.current && generation.current === request;
    busy.current = true; setPending(kind); setError('');
    try { await operation(controller.signal); }
    catch (failure) { if (current()) setError(environmentFailure(failure)); }
    finally { controllers.current.delete(controller); if (current()) { busy.current = false; setPending(undefined); } }
  }, [identity]);

  const load = useCallback(() => action('load', async signal => {
    const value = await swishIntegrationApi.settings(signal);
    if (!signal.aborted && identityRef.current === identity && permittedRef.current) { setState(value); setForm(formFrom(value)); setDirty(false); }
  }), [action, identity]);
  useEffect(() => { if (permitted && matching) void load(); }, [load, permitted, matching]);

  function change(patch: Partial<SettingsForm>) { setForm(previous => previous && { ...previous, ...patch }); setDirty(true); }
  function save() {
    if (!form) return;
    const submitted = structuredClone(form);
    void action('save', async signal => {
      const value = await swishIntegrationApi.saveSettings(submitted, signal);
      if (!signal.aborted && identityRef.current === identity && permittedRef.current) {
        setState(value); setForm(formFrom(value)); setDirty(false); clearIntegrationReadCache('catalog');
        onNotice('Swish-inställningarna är sparade för bolaget.');
      }
    });
  }
  function loadChoices() {
    void action('choices', async signal => {
      const value = await swishIntegrationApi.choices(signal);
      if (!signal.aborted && identityRef.current === identity && permittedRef.current) setChoices(value);
    });
  }

  if (!permitted) return <div className="office-panel integration-message"><ShieldCheck size={19} /><span>Du behöver behörighet att hantera bolagets integrationer för att visa Swish-inställningarna.</span></div>;
  if (!matching) return <div className="office-panel integration-message" role={sessionError ? 'alert' : 'status'}><ShieldCheck size={19} /><span>{sessionError || 'Hämtar bolagets anslutning…'}</span>{!sessionLoading && <button className="office-btn outline" onClick={() => void refreshSession().catch(() => undefined)}>Försök igen</button>}</div>;

  const disabled = !!pending || !form;
  const accounts = choices?.bankAccounts.filter(account => account.active !== false) ?? [];
  const savedAccount = form?.spirisBankAccountId && !accounts.some(account => account.id === form.spirisBankAccountId);
  return <article className="office-panel swish-integration-panel">
    <div className="swish-section-heading"><span className="swish-section-icon"><Smartphone size={25} /></span><div><h2>Swish Utbetalning</h2><p>Inställningar för bolagets testutbetalningar.</p></div><span className="integration-status test"><FlaskConical size={13} />MSS · TEST</span></div>
    <div className="swish-test-note"><ShieldCheck size={18} /><div><strong>Swishs offentliga simulator</strong><p>Inga riktiga pengar flyttas. Skarp Swish-anslutning kan inte aktiveras här.</p></div></div>
    {error && <div className="swish-feedback error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {!state && <div className="swish-feedback" role="status">{pending ? <LoaderCircle size={17} className="swish-spin" /> : <RefreshCw size={17} />}<span>{pending ? 'Hämtar inställningar…' : 'Inställningarna kunde inte hämtas.'}</span>{!pending && <button className="office-btn outline" onClick={() => void load()}>Försök igen</button>}</div>}
    {state && form && <>
      {!state.configuration.ready && <div className="swish-feedback warning"><CircleAlert size={17} /><div><strong>Serverns Swish-test behöver konfigureras</strong><ul>{[...state.configuration.missing, ...state.configuration.issues].map((issue, index) => <li key={`${index}/${issue}`}>{issue}</li>)}</ul></div></div>}
      <label className="swish-check"><input type="checkbox" checked={form.enabled} onChange={event => change({ enabled: event.target.checked })} disabled={disabled} /><span><strong>Aktivera Swish MSS för bolaget</strong><small>Gör testutbetalningar till Swishs syntetiska testmottagare.</small></span></label>
      <section className="swish-bookkeeping-settings"><h3>Efter bekräftat Swish-test</h3><label className="swish-check"><input type="checkbox" checked={form.bookkeepingEnabled} onChange={event => change({ bookkeepingEnabled: event.target.checked })} disabled={disabled} /><span><strong>Registrera testbetalningen i Spiris sandbox</strong><small>Gäller betalningar från viktkort med bokförd leverantörsfaktura. Testsidans fristående prov ändrar inga fakturor.</small></span></label>
        {form.bookkeepingEnabled && <><div className="swish-field-heading"><label htmlFor="swish-spiris-bank">Betalkonto i Spiris</label><button className="office-link" type="button" disabled={disabled} onClick={loadChoices}>{pending === 'choices' ? <LoaderCircle size={14} className="swish-spin" /> : <RefreshCw size={14} />}{pending === 'choices' ? 'Hämtar…' : 'Hämta från Spiris'}</button></div>
          <select id="swish-spiris-bank" value={form.spirisBankAccountId ?? ''} disabled={disabled} onChange={event => change({ spirisBankAccountId: event.target.value || null, spirisCompanyId: event.target.value ? choices?.companyId : null })}>
            <option value="">Välj ett betalkonto från Spiris</option>{savedAccount && <option value={form.spirisBankAccountId ?? ''}>Tidigare valt konto · hämta för att kontrollera</option>}
            {accounts.map(account => <option key={account.id} value={account.id}>{account.name}{account.ledgerAccountNumber ? ` · ${account.ledgerAccountNumber}` : ''}</option>)}
          </select><p className="swish-field-help">Kontot kopplas till det anslutna sandboxföretaget{choices?.companyName ? ` ${choices.companyName}` : ''}. Ingen bokföring sker innan Swish har bekräftat det simulerade resultatet.</p>
          {choices && !accounts.length && <p className="swish-field-help">Inga aktiva betalkonton hittades i Spiris. Lägg till ett betalkonto i testföretaget och hämta igen.</p>}
        </>}
      </section>
      <div className="swish-panel-actions"><Link className="office-btn outline" to="/integrations/swish-test"><FlaskConical size={15} />Öppna Swish-testsidan</Link><button type="button" className="office-btn" disabled={disabled || !dirty} onClick={save}>{pending === 'save' ? <LoaderCircle size={15} className="swish-spin" /> : <Save size={15} />}{pending === 'save' ? 'Sparar…' : 'Spara inställningar'}</button></div>
    </>}
  </article>;
}
