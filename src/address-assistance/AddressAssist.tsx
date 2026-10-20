import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, MapPin, Search, X } from 'lucide-react';
import { companyLookupScope } from '../company-register/client';
import { addressFromGooglePlace, addressSelectionFailure, loadAddressConfig, loadGooglePlaces, validateAddress, withAddressTimeout, type AddressPrediction, type AddressSelectionStage, type AddressValidation, type AddressValue, type GooglePlacesLibrary } from './client';
import './address-assistance.css';

export type { AddressValue } from './client';
export interface AddressAssistProps {
  value: AddressValue;
  onApply(address: AddressValue): void;
  disabled?: boolean;
  scopeKey?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  /** Ordinary Places content must not be used together with, or linked to, a map in the EEA. */
  mapContext?: boolean;
}
type State = { key: string; phase: 'idle' | 'loading' | 'ready' | 'searching' | 'validating' | 'confirm' | 'unavailable'; message?: string; result?: AddressValidation };

/** Optional assistance alongside manual fields. No address is changed until its owner confirms the preview. */
export default function AddressAssist({ value, onApply, disabled = false, scopeKey = '', requestHeaders, mapContext = false }: AddressAssistProps) {
  const id = useId();
  const scope = companyLookupScope(requestHeaders);
  const contextKey = JSON.stringify([scope.key, scopeKey, value, disabled, mapContext]);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<State>({ key: '', phase: 'idle' });
  const [predictions, setPredictions] = useState<AddressPrediction[]>([]);
  const [active, setActive] = useState(-1);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const library = useRef<GooglePlacesLibrary | null>(null);
  const token = useRef<object | null>(null);
  const selectAbort = useRef<AbortController | null>(null);
  const selectedQuery = useRef<string | null>(null);
  const sequence = useRef(0);
  const latest = useRef({ contextKey, scope, onApply, disabled, mapContext });
  latest.current = { contextKey, scope, onApply, disabled, mapContext };
  const visible = state.key === contextKey ? state : { key: contextKey, phase: 'idle' as const };
  const current = (key: string, number: number) => key === latest.current.contextKey && sequence.current === number
    && !latest.current.disabled && !latest.current.mapContext && latest.current.scope.key === companyLookupScope(requestHeaders).key;

  useEffect(() => {
    sequence.current += 1;
    selectAbort.current?.abort();
    setPredictions([]);
    setActive(-1);
    setQuery('');
    selectedQuery.current = null;
    if (!opened || disabled || mapContext) return;
    const controller = new AbortController();
    const requestNumber = sequence.current;
    setState({ key: contextKey, phase: 'loading' });
    void loadAddressConfig(scope, controller.signal).then(async config => {
      if (!current(contextKey, requestNumber) || controller.signal.aborted) return;
      if (!config.configured || !config.browserApiKey || !config.validationConfigured) {
        setState({ key: contextKey, phase: 'unavailable', message: 'Adresshjälpen är inte aktiverad ännu. Du kan fylla i adressen i fälten nedan.' });
        return;
      }
      const places = await loadGooglePlaces(config.browserApiKey);
      if (!current(contextKey, requestNumber) || controller.signal.aborted) return;
      library.current = places;
      token.current = new places.AutocompleteSessionToken();
      setState({ key: contextKey, phase: 'ready' });
    }).catch(() => {
      if (current(contextKey, requestNumber) && !controller.signal.aborted)
        setState({ key: contextKey, phase: 'unavailable', message: 'Adresshjälpen kunde inte startas. Du kan alltid fylla i adressen manuellt.' });
    });
    return () => { controller.abort(); selectAbort.current?.abort(); sequence.current += 1; library.current = null; token.current = null; };
    // The key includes every editable field and the initiating authentication scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, contextKey]);

  useEffect(() => {
    if (!opened || disabled || mapContext || !library.current || !token.current || (selectedQuery.current !== null && selectedQuery.current === query)) return;
    const search = query.trim();
    let abandoned = false;
    const requestNumber = ++sequence.current;
    setPredictions([]);
    setActive(-1);
    if (search.length < 3) { setState({ key: contextKey, phase: 'ready' }); return; }
    setState({ key: contextKey, phase: 'searching' });
    const timer = globalThis.setTimeout(() => {
      const places = library.current, session = token.current;
      if (!places || !session) return;
      void withAddressTimeout(places.AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: search, sessionToken: session, includedRegionCodes: ['se'], language: 'sv', region: 'se' })).then(result => {
        if (abandoned || !current(contextKey, requestNumber)) return;
        const found = result.suggestions.flatMap(item => item.placePrediction ? [{ label: item.placePrediction.text.toString(), toPlace: () => item.placePrediction!.toPlace() }] : []).slice(0, 5);
        setPredictions(found);
        setState({ key: contextKey, phase: 'ready', ...(!found.length ? { message: 'Inga adressförslag. Kontrollera stavningen eller fyll i adressen manuellt.' } : {}) });
      }).catch(() => {
        if (!abandoned && current(contextKey, requestNumber)) setState({ key: contextKey, phase: 'unavailable', message: 'Adressförslag kunde inte hämtas. Fyll i adressen manuellt eller försök igen.' });
      });
    }, 350);
    return () => { abandoned = true; globalThis.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, contextKey, opened, disabled, mapContext, searchAttempt]);

  const select = async (prediction: AddressPrediction) => {
    if (disabled || !library.current || !token.current || mapContext || state.key !== contextKey) return;
    const key = contextKey, requestNumber = ++sequence.current;
    selectAbort.current?.abort();
    const controller = new AbortController();
    selectAbort.current = controller;
    selectedQuery.current = prediction.label;
    setQuery(prediction.label);
    setPredictions([]);
    setActive(-1);
    setState({ key, phase: 'validating' });
    let stage: AddressSelectionStage = 'details';
    try {
      const place = prediction.toPlace();
      await withAddressTimeout(place.fetchFields({ fields: ['addressComponents', 'formattedAddress'] }));
      if (!current(key, requestNumber) || controller.signal.aborted) return;
      token.current = new library.current!.AutocompleteSessionToken();
      stage = 'components';
      const address = addressFromGooglePlace(place);
      stage = 'validation';
      const result = await validateAddress(address, scope, controller.signal);
      if (!current(key, requestNumber) || controller.signal.aborted) return;
      setState({ key, phase: 'confirm', result });
    } catch (failure) {
      if (current(key, requestNumber) && !controller.signal.aborted)
        setState({ key, phase: 'unavailable', message: addressSelectionFailure(failure, stage) });
    }
  };
  const apply = () => {
    if (visible.phase !== 'confirm' || !visible.result || disabled || mapContext
      || latest.current.contextKey !== contextKey || latest.current.scope.key !== companyLookupScope(requestHeaders).key) return;
    const confirmed = { ...visible.result.address };
    // This click is the explicit end-user confirmation of the address, not a background Google cache.
    latest.current.onApply(confirmed);
    setOpened(false);
  };
  if (mapContext) return <div className="address-assist address-assist-manual"><MapPin size={14} aria-hidden="true" /><span>Fyll i adressen manuellt. Kartans adressökning används separat.</span></div>;
  const busy = ['loading', 'searching', 'validating'].includes(visible.phase);
  const result = visible.result;
  return <section className={`address-assist${opened ? ' is-open' : ''}`} aria-label="Adresshjälp" aria-busy={busy}>
    <button type="button" className="address-assist-toggle" disabled={disabled} aria-expanded={opened} aria-controls={`${id}-body`} onClick={() => setOpened(value => !value)}>
      <Search size={15} aria-hidden="true" /><span>Sök och komplettera adress</span>{opened ? <X size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
    </button>
    {opened && <div id={`${id}-body`} className="address-assist-body">
      <p>Sök en svensk postadress. Granska och bekräfta förslaget innan adressfälten ändras. Hämtplatser utan postadress kan alltid fyllas i manuellt.</p>
      {visible.phase !== 'loading' && library.current && <div className="address-assist-search">
        <label htmlFor={`${id}-query`}>Sök adress</label>
        <input id={`${id}-query`} role="combobox" type="search" autoComplete="off" value={query} disabled={disabled || visible.phase === 'validating'}
          aria-autocomplete="list" aria-expanded={state.key === contextKey && predictions.length > 0} aria-controls={`${id}-list`} aria-activedescendant={state.key === contextKey && active >= 0 && predictions[active] ? `${id}-option-${active}` : undefined}
          placeholder="Gata och ort, minst 3 tecken" onChange={event => { sequence.current += 1; selectAbort.current?.abort(); selectedQuery.current = null; setPredictions([]); setActive(-1); setState({ key: contextKey, phase: 'ready' }); setQuery(event.target.value); setSearchAttempt(value => value + 1); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' && predictions.length) { event.preventDefault(); setActive(value => (value + 1) % predictions.length); }
            else if (event.key === 'ArrowUp' && predictions.length) { event.preventDefault(); setActive(value => (value - 1 + predictions.length) % predictions.length); }
            else if (event.key === 'Enter') { event.preventDefault(); if (active >= 0 && predictions[active]) void select(predictions[active]); }
            else if (event.key === 'Escape') { event.preventDefault(); setPredictions([]); setActive(-1); }
          }} />
        {state.key === contextKey && predictions.length > 0 && <ul id={`${id}-list`} role="listbox" className="address-assist-options" aria-label="Adressförslag">
          {predictions.map((prediction, index) => <li key={`${index}-${prediction.label}`} role="option" id={`${id}-option-${index}`} aria-selected={active === index}>
            <button type="button" tabIndex={-1} className={active === index ? 'is-active' : ''} onClick={() => { void select(prediction); }}><MapPin size={14} aria-hidden="true" />{prediction.label}</button>
          </li>)}
        </ul>}
        <div className="address-assist-attribution"><img src="https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-white3.png" alt="Powered by Google" width="120" height="14" /></div>
      </div>}
      <div className="address-assist-status" role="status" aria-live="polite" aria-atomic="true">
        {busy && <span><LoaderCircle size={14} aria-hidden="true" />{visible.phase === 'loading' ? 'Startar adresshjälpen…' : visible.phase === 'validating' ? 'Kontrollerar adressen…' : 'Söker adressförslag…'}</span>}
        {!busy && visible.message && <span>{visible.message}</span>}
      </div>
      {visible.phase === 'confirm' && result && <div className="address-assist-confirm">
        <strong>Stämmer adressen?</strong>
        <span>{result.address.address}</span><span>{result.address.postalCode.replace(/^(\d{3})(\d{2})$/, '$1 $2')} {result.address.city}</span>
        {(!result.verdict.addressComplete || result.verdict.hasUnconfirmedComponents || result.verdict.hasInferredComponents || result.verdict.hasReplacedComponents)
          && <p>Kontrollera husnummer, postnummer och ort extra noga. Förslaget innehåller uppgifter som behöver din bekräftelse.</p>}
        <button type="button" disabled={disabled} onClick={apply}><Check size={15} aria-hidden="true" />Adressen stämmer – använd adressen</button>
        <small>Du bekräftar adressen som din uppgift. Formuläret sparas separat.</small>
      </div>}
    </div>}
  </section>;
}
