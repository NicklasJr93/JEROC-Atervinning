import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { companyLookupScope } from '../company-register/client';
import { addressSelectionFailure, loadAddressConfig, loadGooglePlaces, selectionFromGooglePlace, validateAddress, withAddressTimeout,
  type AddressPrediction, type AddressSelectionStage, type AddressValue, type GooglePlacesLibrary } from './client';
import './address-assistance.css';

export interface AddressFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
  /** Keep the name stable when suggestions/status are rendered inside a label. */
  'aria-label': string;
  value: AddressValue;
  /** Combined origin fields retain their existing display/formatting adapter. */
  textValue?: string;
  onChange(text: string): void;
  onApply(address: AddressValue): void;
  scopeKey?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  mapContext?: boolean;
}
type Status = { identity: string; phase: 'idle' | 'loading' | 'searching' | 'validating'; message?: string };
type Choices = { identity: string; signature: string; items: AddressPrediction[] };

/** Autocomplete lives in the real manual field. Only an active selection (or
 * a number typed after a selected street) can populate the related fields.
 * Ordinary form save remains separate. All async work is scoped to the actor,
 * form and exact address revision that initiated it.
 */
export default function AddressField({ value, textValue, onChange, onApply, scopeKey = '', requestHeaders,
  mapContext = false, disabled = false, readOnly = false, onFocus, onBlur, onKeyDown, id: suppliedId, ...inputProps }: AddressFieldProps) {
  const generatedId = useId(), id = suppliedId ?? `${generatedId}-address`;
  const input = useRef<HTMLInputElement>(null);
  const scope = companyLookupScope(requestHeaders);
  const identity = JSON.stringify([scope.key, scopeKey, disabled, readOnly, mapContext]);
  const text = textValue ?? value.address;
  const signature = JSON.stringify([text, value.address, value.postalCode, value.city, value.countryCode]);
  const [focused, setFocused] = useState(false), [ready, setReady] = useState(0);
  const [status, setStatus] = useState<Status>({ identity: '', phase: 'idle' });
  const [choices, setChoices] = useState<Choices>({ identity: '', signature: '', items: [] });
  const [active, setActive] = useState(-1);
  const places = useRef<GooglePlacesLibrary | null>(null), session = useRef<object | null>(null);
  const validationAvailable = useRef(false);
  const sequence = useRef(0), selectionAbort = useRef<AbortController | null>(null);
  const edited = useRef(false), ownEdit = useRef<string | undefined>(undefined);
  const street = useRef<{ name: string; city: string } | undefined>(undefined);
  const latest = useRef({ identity, signature, scope, value, text, onChange, onApply, disabled, readOnly, mapContext });
  latest.current = { identity, signature, scope, value, text, onChange, onApply, disabled, readOnly, mapContext };
  const visible = status.identity === identity ? status : { identity, phase: 'idle' as const };
  const options = choices.identity === identity && choices.signature === signature ? choices.items : [];
  const available = () => !latest.current.disabled && !latest.current.readOnly && !latest.current.mapContext
    && !input.current?.matches(':disabled') && latest.current.scope.key === companyLookupScope(requestHeaders).key;
  const current = (key: string, version: string, number: number) => available()
    && latest.current.identity === key && latest.current.signature === version && sequence.current === number;
  const clearChoices = () => { setChoices({ identity: '', signature: '', items: [] }); setActive(-1); };

  useEffect(() => {
    sequence.current++; selectionAbort.current?.abort(); clearChoices();
    edited.current = false; ownEdit.current = undefined; street.current = undefined;
    places.current = null; session.current = null; validationAvailable.current = false;
    return () => { sequence.current++; selectionAbort.current?.abort(); };
  }, [identity]);

  useEffect(() => {
    sequence.current++; selectionAbort.current?.abort(); clearChoices();
    if (text !== ownEdit.current) edited.current = false;
    // External fills (for example SCB) also cancel any old loading indicator.
    // A successful apply already supplies its own idle review message.
    setStatus(previous => text === ownEdit.current || previous.phase !== 'idle' ? { identity, phase: 'idle' } : previous);
    // Values can change externally through SCB, saved addresses, manual postal
    // edits or draft switching. Those revisions invalidate every old result.
  }, [signature]);

  useEffect(() => {
    if (!focused || disabled || readOnly || mapContext || places.current) return;
    const controller = new AbortController();
    setStatus({ identity, phase: 'loading' });
    void loadAddressConfig(scope, controller.signal).then(async config => {
      if (controller.signal.aborted || latest.current.identity !== identity || !available()) return;
      if (!config.configured || !config.browserApiKey) {
        setStatus({ identity, phase: 'idle', message: 'Adressförslag är inte tillgängliga. Du kan fylla i adressen manuellt.' }); return;
      }
      const library = await loadGooglePlaces(config.browserApiKey);
      if (controller.signal.aborted || latest.current.identity !== identity || !available()) return;
      places.current = library; session.current = new library.AutocompleteSessionToken();
      validationAvailable.current = config.validationConfigured;
      setReady(version => version + 1); setStatus({ identity, phase: 'idle' });
    }).catch(() => {
      if (!controller.signal.aborted && latest.current.identity === identity)
        setStatus({ identity, phase: 'idle', message: 'Adressförslag kunde inte startas. Du kan fylla i adressen manuellt.' });
    });
    return () => controller.abort();
    // Scope identity intentionally excludes editable address values.
  }, [focused, identity]);

  useEffect(() => {
    if (!focused || !edited.current || !places.current || !session.current || !available()) return;
    let abandoned = false;
    const search = text.trim(), number = ++sequence.current;
    clearChoices();
    if (search.length < 3 || street.current && search === street.current.name) return;
    const city = street.current?.city;
    const query = city && !search.toLocaleLowerCase('sv').includes(city.toLocaleLowerCase('sv')) ? `${search}, ${city}` : search;
    const timer = globalThis.setTimeout(() => {
      const library = places.current, token = session.current;
      if (!library || !token) return;
      setStatus({ identity, phase: 'searching' });
      void withAddressTimeout(library.AutocompleteSuggestion.fetchAutocompleteSuggestions({ input: query, sessionToken: token,
        includedRegionCodes: ['se'], language: 'sv', region: 'se' })).then(result => {
        if (abandoned || !current(identity, signature, number)) return;
        const items = result.suggestions.flatMap(item => item.placePrediction
          ? [{ label: item.placePrediction.text.toString(), toPlace: () => item.placePrediction!.toPlace() }] : []).slice(0, 5);
        setChoices({ identity, signature, items });
        setStatus({ identity, phase: 'idle', ...(!items.length ? { message: 'Inga förslag. Fortsätt skriva eller fyll i adressen manuellt.' } : {}) });
      }).catch(() => {
        if (!abandoned && current(identity, signature, number))
          setStatus({ identity, phase: 'idle', message: 'Adressförslag kunde inte hämtas. Du kan fortsätta manuellt.' });
      });
    }, 350);
    return () => { abandoned = true; globalThis.clearTimeout(timer); };
  }, [text, signature, identity, focused, ready]);

  async function validate(address: AddressValue, key: string, version: string, number: number, controller: AbortController) {
    const proposal = await validateAddress(address, latest.current.scope, controller.signal);
    if (!current(key, version, number) || controller.signal.aborted) return;
    edited.current = false; ownEdit.current = undefined; street.current = undefined; clearChoices();
    const needsReview = !proposal.verdict.addressComplete || proposal.verdict.hasUnconfirmedComponents
      || proposal.verdict.hasInferredComponents || proposal.verdict.hasReplacedComponents;
    latest.current.onApply({ ...proposal.address });
    setStatus({ identity: key, phase: 'idle', message: needsReview
      ? 'Adressfälten är ifyllda. Kontrollera husnummer, postnummer och ort innan du sparar.'
      : 'Postnummer och ort är ifyllda. Kontrollera adressen innan du sparar.' });
  }

  async function select(prediction: AddressPrediction) {
    if (!available() || !places.current) return;
    const key = identity, version = signature, number = ++sequence.current;
    selectionAbort.current?.abort(); const controller = new AbortController(); selectionAbort.current = controller;
    edited.current = false; clearChoices(); setStatus({ identity: key, phase: 'validating' });
    let stage: AddressSelectionStage = 'details';
    let selectedAddress: AddressValue | undefined;
    try {
      const place = prediction.toPlace();
      await withAddressTimeout(place.fetchFields({ fields: ['addressComponents', 'formattedAddress'] }));
      if (!current(key, version, number) || controller.signal.aborted) return;
      session.current = new places.current!.AutocompleteSessionToken();
      stage = 'components';
      const selected = selectionFromGooglePlace(place);
      selectedAddress = selected.address;
      if (!selected.hasHouseNumber) {
        street.current = { name: selected.address.address, city: selected.address.city };
        // A street can cross several postal areas, even if Places returns a
        // postcode for the street itself. Wait for the house number.
        latest.current.onApply({ ...selected.address, postalCode: '' });
        setStatus({ identity: key, phase: 'idle', message: 'Lägg till husnummer. Postnummer och ort kompletteras när adressen är klar.' });
        requestAnimationFrame(() => {
          if (latest.current.identity !== key || !available()) return;
          input.current?.focus(); input.current?.setSelectionRange(selected.address.address.length, selected.address.address.length);
        });
        return;
      }
      // Places already returns the selected address's structured details. A
      // separate validation service must never block those editable fields.
      // No validation request is started for a complete Places address, so a
      // delayed provider response cannot later replace manual corrections.
      if (selected.complete) {
        ownEdit.current = undefined; street.current = undefined;
        latest.current.onApply({ ...selected.address });
        setStatus({ identity: key, phase: 'idle', message: 'Postnummer och ort är ifyllda. Kontrollera adressen innan du sparar.' });
        return;
      }
      if (!validationAvailable.current) {
        latest.current.onApply({ ...selected.address });
        setStatus({ identity: key, phase: 'idle', message: 'Google-träffen saknar postnummer eller ort. Komplettera de tomma fälten eller välj en mer exakt adress.' });
        return;
      }
      stage = 'validation'; await validate(selected.address, key, version, number, controller);
    } catch (failure) {
      if (current(key, version, number) && !controller.signal.aborted) {
        // Keep the usable Places fields even if optional completion is down.
        if (stage === 'validation' && selectedAddress) {
          latest.current.onApply({ ...selectedAddress });
          setStatus({ identity: key, phase: 'idle', message: 'Gatuadressen är ifylld. Google-träffen saknar postnummer eller ort och kunde inte kompletteras. Fyll i de tomma fälten manuellt.' });
        } else setStatus({ identity: key, phase: 'idle', message: addressSelectionFailure(failure, stage) });
      }
    }
  }

  function validateTypedNumber() {
    const selected = street.current, currentValue = latest.current;
    if (!selected || !available() || !validationAvailable.current) return;
    const address = currentValue.text.split(',')[0].trim();
    if (!address.startsWith(selected.name) || !/\d/.test(address.slice(selected.name.length))) return;
    const key = currentValue.identity, version = currentValue.signature, number = ++sequence.current;
    selectionAbort.current?.abort(); const controller = new AbortController(); selectionAbort.current = controller;
    edited.current = false; clearChoices(); setStatus({ identity: key, phase: 'validating' });
    void validate({ address, city: selected.city, postalCode: '', countryCode: 'SE' }, key, version, number, controller).catch(failure => {
      if (current(key, version, number) && !controller.signal.aborted)
        setStatus({ identity: key, phase: 'idle', message: addressSelectionFailure(failure, 'validation') });
    });
  }
  function keyboard(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && options.length) { event.preventDefault(); setActive(at => (at + 1) % options.length); }
    else if (event.key === 'ArrowUp' && options.length) { event.preventDefault(); setActive(at => (at - 1 + options.length) % options.length); }
    else if (event.key === 'Enter' && options.length) { event.preventDefault(); void select(options[active >= 0 ? active : 0]); }
    else if (event.key === 'Escape') { event.preventDefault(); edited.current = false; clearChoices(); }
    else if (event.key === 'Enter' && street.current) { event.preventDefault(); validateTypedNumber(); }
    if (!event.defaultPrevented) onKeyDown?.(event);
  }
  const busy = ['loading', 'searching', 'validating'].includes(visible.phase);
  return <span className="address-field">
    <span className="address-field-input">
      <input {...inputProps} ref={input} id={id} value={text} disabled={disabled} readOnly={readOnly}
        role={mapContext || readOnly ? inputProps.role : 'combobox'} autoComplete={inputProps.autoComplete ?? 'street-address'}
        aria-autocomplete={mapContext || readOnly ? undefined : 'list'} aria-expanded={options.length > 0}
        aria-controls={options.length ? `${id}-options` : undefined}
        aria-activedescendant={options[active] ? `${id}-option-${active}` : undefined}
        aria-describedby={[inputProps['aria-describedby'], visible.message || busy ? `${id}-status` : undefined].filter(Boolean).join(' ') || undefined}
        list={options.length ? undefined : inputProps.list}
        onFocus={event => { setFocused(true); onFocus?.(event); }}
        onBlur={event => { setFocused(false); clearChoices(); onBlur?.(event); if (!event.defaultPrevented) validateTypedNumber(); }}
        onKeyDown={keyboard}
        onChange={event => {
          sequence.current++; selectionAbort.current?.abort(); clearChoices();
          let next = event.target.value;
          const name = street.current?.name;
          if (name && !next.startsWith(name)) street.current = undefined;
          if (name && next.startsWith(name) && /^\d/.test(next.slice(name.length))) next = `${name} ${next.slice(name.length)}`;
          ownEdit.current = next; edited.current = true;
          setStatus({ identity, phase: 'idle' }); onChange(next);
          if (next !== event.target.value) requestAnimationFrame(() => input.current?.setSelectionRange(name!.length + 2, name!.length + 2));
        }} />
      {options.length > 0 && <span id={`${id}-options`} role="listbox" className="address-field-options" aria-label="Adressförslag">
        {options.map((option, index) => <span key={`${index}-${option.label}`} id={`${id}-option-${index}`} role="option"
          className={index === active ? 'is-active' : ''} aria-selected={index === active}
          onMouseDown={event => event.preventDefault()} onClick={event => { event.preventDefault(); event.stopPropagation(); void select(option); }}>{option.label}</span>)}
        <span className="address-assist-attribution"><img src="https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-white3.png" alt="Powered by Google" width="120" height="14" /></span>
      </span>}
    </span>
    {!mapContext && !readOnly && <span id={`${id}-status`} className="address-field-status" role="status" aria-live="polite" aria-atomic="true">
      {busy ? visible.phase === 'loading' ? 'Startar adressförslag…' : visible.phase === 'validating' ? 'Hämtar postnummer och ort…' : 'Söker adresser…' : visible.message}
    </span>}
  </span>;
}
