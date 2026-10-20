import { useEffect, useId, useState } from 'react';
import { Check, CircleAlert, MapPin, RefreshCw, ShieldCheck } from 'lucide-react';
import AddressField from '../address-assistance/AddressField';
import { loadAddressConfig, type AddressConfig, type AddressValue } from '../address-assistance/client';
import { companyLookupScope, type CompanyLookupScope } from '../company-register/client';
import { can, type OfficeUser } from './model';

interface Props { user: OfficeUser; actualUser: OfficeUser; refreshKey?: number }
const emptyAddress: AddressValue = { address: '', postalCode: '', city: '', countryCode: 'SE' };

export default function GoogleAddressIntegrationPanel({ user, actualUser, refreshKey = 0 }: Props) {
  const scope = companyLookupScope({ 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id });
  const identity = JSON.stringify([scope.key, actualUser.permissions, actualUser.level, user.permissions, user.level]);
  const mayTest = can(actualUser, 'integrationsManage') && can(user, 'integrationsManage');
  // Drop previous test input and configuration immediately after an account or
  // tenant change; an old configuration response cannot populate the new view.
  return <GoogleAddressPanel key={identity} scope={scope} mayTest={mayTest} refreshKey={refreshKey} />;
}

function GoogleAddressPanel({ scope, mayTest, refreshKey }: { scope: CompanyLookupScope; mayTest: boolean; refreshKey: number }) {
  const id = useId();
  const [config, setConfig] = useState<AddressConfig>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [testing, setTesting] = useState(false);
  const [address, setAddress] = useState<AddressValue>({ ...emptyAddress });
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setConfig(undefined); setError('');
    void loadAddressConfig(scope, controller.signal).then(result => {
      if (!controller.signal.aborted) setConfig(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Inställningarna för adresshjälpen kunde inte hämtas. Försök igen.');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
    // The stable scope key contains the initiating tenant and account headers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.key, refreshKey, retry]);

  const setField = (field: 'address' | 'postalCode' | 'city', value: string) => {
    setAddress(previous => ({ ...previous, [field]: value })); setConfirmed(false);
  };

  return <article className="office-panel integration-detail environment-panel" aria-label="Google adressinställningar">
    <div className="integration-detail-heading">
      <span className="integration-icon"><MapPin size={25} aria-hidden="true" /></span>
      <div><small>Adresshjälp</small><h2>Google adresser</h2><p>Skriv direkt i adressfältet och välj en träff för att fylla i postnummer och ort.</p></div>
      {!loading && config && <span className={`integration-status ${config.configured ? 'test' : 'warning'}`}><ShieldCheck size={13} aria-hidden="true" />{config.configured ? 'Konfigurerad' : 'Inställningar saknas'}</span>}
    </div>

    {loading ? <div className="integration-message" role="status"><RefreshCw size={17} aria-hidden="true" /><span>Hämtar adressinställningar…</span></div>
      : error ? <div className="integration-message error" role="alert"><CircleAlert size={17} aria-hidden="true" /><span>{error}</span><button className="office-btn outline" type="button" onClick={() => setRetry(value => value + 1)}>Försök igen</button></div>
        : config && <>
          <div className="integration-detail-columns">
            <div><h3>Serverns inställningar</h3><ul className="integration-functions">
              <li>{config.browserConfigured ? <Check size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}<span>Webbläsarnyckel för adressförslag: <strong>{config.browserConfigured ? 'Registrerad' : 'Saknas'}</strong></span></li>
              <li>{config.validationConfigured ? <Check size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}<span>Servernyckel för extra adresskontroll (valfri): <strong>{config.validationConfigured ? 'Registrerad' : 'Saknas'}</strong></span></li>
            </ul><p>Konfigurationen visar vilka nycklar som finns. Postnummer och ort hämtas från den valda Google Places-adressen. Extra adresskontroll krävs inte för att fylla i fälten.</p></div>
            <div><h3>Det här ingår</h3><ul className="integration-functions"><li><MapPin size={14} aria-hidden="true" /><span>Adressförslag i kund- och ursprungsfält.</span></li><li><Check size={14} aria-hidden="true" /><span>Gata, postnummer och ort fylls i när du väljer en komplett adress.</span></li><li><ShieldCheck size={14} aria-hidden="true" /><span>Formuläret sparas separat. Manuell adressinmatning finns alltid kvar.</span></li></ul></div>
          </div>
          <details><summary>Så konfigureras adresshjälpen</summary><div><p>Lägg webbläsarnyckeln i Render → scrapplanner-app → Environment och deploya appen. Extra serverkontroll använder en separat, valfri nyckel.</p><ul className="integration-setup">
            <li><code>GOOGLE_MAPS_BROWSER_API_KEY</code>: Maps JavaScript API och Places API (New). Begränsa nyckeln till era webbplatser, exempelvis <code>https://app.scrapplanner.com/*</code> och <code>https://mobile.scrapplanner.com/*</code>.</li>
            <li><code>GOOGLE_ADDRESS_VALIDATION_API_KEY</code> (valfri): aktivera Address Validation API i samma Google Cloud-projekt som nyckeln. Begränsa nyckeln till endast detta API och appserverns utgående IP-adresser.</li>
          </ul><p>Kontrollen ovan verifierar inte begränsningar eller fakturering i Google Cloud. Nycklarnas värden visas inte här.</p></div></details>
          {!mayTest && <p>Du behöver behörighet att hantera integrationer för att prova adresshjälpen här.</p>}
          <p><button className="office-btn" type="button" disabled={!config.configured || !mayTest} aria-expanded={testing} aria-controls={`${id}-test`} onClick={() => setTesting(value => !value)}><MapPin size={15} aria-hidden="true" />{testing ? 'Stäng adressprovet' : 'Testa adresshjälpen'}</button></p>
          {!config.configured && <p>Lägg till webbläsarnyckeln för att aktivera adressförslagen. Kundkortens adressfält kan fyllas i manuellt under tiden.</p>}
        </>}

    {testing && !loading && config?.configured && mayTest && <section id={`${id}-test`} aria-labelledby={`${id}-test-title`}>
      <h3 id={`${id}-test-title`}>Fristående adressprov</h3><p>Skriv i gatuadressfältet och välj en adress för att fylla i postnummer och ort. Provet ändrar ingen kund och sparar inga kunduppgifter.</p>
      <div className="environment-form-grid">
        <label htmlFor={`${id}-street`}>Gatuadress<AddressField aria-label="Gatuadress" id={`${id}-street`} autoComplete="off" value={address} scopeKey="integration-address-test" requestHeaders={scope.headers} onChange={value => setField('address', value)} onApply={result => { setAddress(result); setConfirmed(true); }} /></label>
        <label htmlFor={`${id}-postal`}>Postnummer<input id={`${id}-postal`} inputMode="numeric" autoComplete="off" value={address.postalCode} onChange={event => setField('postalCode', event.target.value)} /></label>
        <label htmlFor={`${id}-city`}>Ort<input id={`${id}-city`} autoComplete="off" value={address.city} onChange={event => setField('city', event.target.value)} /></label>
      </div>
      {confirmed && address.postalCode && <p role="status">Adressfälten är ifyllda för provet. Inga kunduppgifter har sparats.</p>}
    </section>}
  </article>;
}
