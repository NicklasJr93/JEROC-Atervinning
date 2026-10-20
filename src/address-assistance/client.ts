import { companyLookupScope, type CompanyLookupScope } from '../company-register/client';

export interface AddressValue { address: string; postalCode: string; city: string; countryCode?: string }
export interface AddressConfig { configured: boolean; browserConfigured: boolean; browserApiKey?: string; validationConfigured: boolean; countryCode: 'SE' }
export interface AddressValidation {
  address: AddressValue & { countryCode: 'SE' };
  verdict: { addressComplete: boolean; hasUnconfirmedComponents: boolean; hasInferredComponents: boolean; hasReplacedComponents: boolean; requiresConfirmation: true };
}
export class AddressAssistanceError extends Error {
  constructor(message: string, public code: string, public status = 0) { super(message); }
}

export type AddressSelectionStage = 'details' | 'components' | 'validation';

/** Only our own sanitized errors may be shown. SDK errors can contain request URLs or keys. */
export function addressSelectionFailure(failure: unknown, stage: AddressSelectionStage): string {
  if (failure instanceof AddressAssistanceError) return failure.message;
  if (stage === 'details') return 'Adressens detaljer kunde inte hämtas från Google. Försök igen eller fyll i adressen manuellt.';
  if (stage === 'components') return 'Träffen saknar uppgifter för gata, postnummer eller ort. Välj en mer exakt adress eller fyll i adressen manuellt.';
  return 'Serverns adresskontroll kunde inte nås. Försök igen eller fyll i adressen manuellt.';
}

export function parseAddressConfig(input: unknown): AddressConfig {
  const value = input as Partial<AddressConfig> | null;
  if (!value || typeof value !== 'object' || typeof value.configured !== 'boolean'
    || typeof value.validationConfigured !== 'boolean' || value.countryCode !== 'SE'
    || (value.configured && (typeof value.browserApiKey !== 'string' || !value.browserApiKey.trim() || !value.validationConfigured)))
    throw new AddressAssistanceError('Adresshjälpen gav ett ofullständigt svar.', 'address_response_invalid', 502);
  return { configured: value.configured, browserConfigured: typeof value.browserConfigured === 'boolean' ? value.browserConfigured : Boolean(value.browserApiKey), validationConfigured: value.validationConfigured, countryCode: 'SE',
    ...(value.configured ? { browserApiKey: value.browserApiKey } : {}) };
}

/** Only the address confirmed by the user is sent back to the form. Never keep Google's full response. */
export function parseAddressValidation(input: unknown): AddressValidation {
  const value = input as Partial<AddressValidation> | null;
  const address = value?.address, verdict = value?.verdict;
  if (!address || typeof address !== 'object' || address.countryCode !== 'SE'
    || !['address', 'city'].every(key => typeof address[key as keyof AddressValue] === 'string' && String(address[key as keyof AddressValue]).trim().length > 0 && String(address[key as keyof AddressValue]).length <= 300)
    || typeof address.postalCode !== 'string' || !/^\d{3}\s?\d{2}$/.test(address.postalCode)
    || !verdict || verdict.requiresConfirmation !== true
    || !['addressComplete', 'hasUnconfirmedComponents', 'hasInferredComponents', 'hasReplacedComponents'].every(key => typeof verdict[key as keyof typeof verdict] === 'boolean'))
    throw new AddressAssistanceError('Adressen kunde inte delas upp. Fyll i adressen manuellt.', 'address_response_invalid', 502);
  return { address: { address: address.address.trim(), postalCode: address.postalCode.replace(/\s/g, ''), city: address.city.trim(), countryCode: 'SE' },
    verdict: { addressComplete: verdict.addressComplete, hasUnconfirmedComponents: verdict.hasUnconfirmedComponents,
      hasInferredComponents: verdict.hasInferredComponents, hasReplacedComponents: verdict.hasReplacedComponents, requiresConfirmation: true } };
}

async function request(path: string, body: unknown, scope: CompanyLookupScope, signal: AbortSignal | undefined): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    const response = await fetch(path, { method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...scope.headers }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => null);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (scope.platformKey !== companyLookupScope().platformKey)
      throw new AddressAssistanceError('Inloggningen eller bolaget har ändrats. Öppna adresshjälpen igen.', 'address_selection_changed', 409);
    if (!response.ok) throw new AddressAssistanceError(typeof result?.error === 'string' ? result.error : 'Adresshjälpen kunde inte nås.',
      typeof result?.code === 'string' ? result.code : 'address_unavailable', response.status);
    return result;
  } catch (error) {
    if (timedOut) throw new AddressAssistanceError('Adresshjälpen svarade inte i tid. Du kan fylla i adressen manuellt.', 'address_unavailable');
    if (controller.signal.aborted || error instanceof AddressAssistanceError) throw error;
    throw new AddressAssistanceError('Adresshjälpen kunde inte nås. Du kan fylla i adressen manuellt.', 'address_unavailable');
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function loadAddressConfig(scope: CompanyLookupScope, signal?: AbortSignal): Promise<AddressConfig> {
  return parseAddressConfig(await request('/api/address-assistance/config', {}, scope, signal));
}
export async function validateAddress(address: AddressValue, scope: CompanyLookupScope, signal?: AbortSignal): Promise<AddressValidation> {
  return parseAddressValidation(await request('/api/address-assistance/validate', { address: { ...address, countryCode: 'SE' } }, scope, signal));
}

interface PlaceAddressComponent { longText: string; shortText?: string; types: string[] }
export interface GooglePlace { formattedAddress?: string; addressComponents?: PlaceAddressComponent[]; fetchFields(options: { fields: string[] }): Promise<unknown> }
export interface AddressPrediction { label: string; toPlace(): GooglePlace }
export interface GooglePlacesLibrary {
  AutocompleteSessionToken: new () => object;
  AutocompleteSuggestion: { fetchAutocompleteSuggestions(options: { input: string; sessionToken: object; includedRegionCodes: string[]; language: string; region: string }): Promise<{ suggestions: { placePrediction?: { text: { toString(): string }; toPlace(): GooglePlace } }[] }> };
}
type GoogleMapsWindow = Window & { google?: { maps?: { importLibrary(name: 'places'): Promise<GooglePlacesLibrary> } }; __scrapplannerAddressMapsReady?: () => void; gm_authFailure?: () => void };
let placesPromise: Promise<GooglePlacesLibrary> | undefined;

export async function withAddressTimeout<T>(operation: Promise<T>, milliseconds = 12_000): Promise<T> {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timeout = globalThis.setTimeout(() => reject(new AddressAssistanceError('Adresshjälpen svarade inte i tid.', 'address_unavailable')), milliseconds); })]); }
  finally { if (timeout !== undefined) globalThis.clearTimeout(timeout); }
}

/** Maps code and the intentionally public browser key load only after the user opens address assistance. */
export function loadGooglePlaces(browserApiKey: string): Promise<GooglePlacesLibrary> {
  const target = window as GoogleMapsWindow;
  if (target.google?.maps?.importLibrary) return withAddressTimeout(target.google.maps.importLibrary('places'));
  if (placesPromise) return placesPromise;
  placesPromise = new Promise<GooglePlacesLibrary>((resolve, reject) => {
    const script = document.createElement('script');
    let finished = false;
    const previousAuthFailure = target.gm_authFailure;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timeout);
      delete target.__scrapplannerAddressMapsReady;
      target.gm_authFailure = previousAuthFailure;
      if (error) { script.remove(); reject(error); return; }
      if (!target.google?.maps?.importLibrary) { reject(new Error('address_sdk_unavailable')); return; }
      void withAddressTimeout(target.google.maps.importLibrary('places')).then(resolve, reject);
    };
    const timeout = globalThis.setTimeout(() => finish(new Error('address_sdk_timeout')), 12_000);
    target.__scrapplannerAddressMapsReady = () => finish();
    target.gm_authFailure = () => { finish(new Error('address_sdk_auth')); previousAuthFailure?.(); };
    const url = new URL('https://maps.googleapis.com/maps/api/js');
    url.search = new URLSearchParams({ key: browserApiKey, loading: 'async', callback: '__scrapplannerAddressMapsReady', libraries: 'places', v: 'weekly', language: 'sv', region: 'SE' }).toString();
    script.src = url.href;
    script.async = true;
    script.onerror = () => finish(new Error('address_sdk_unavailable'));
    // Honor a nonce supplied by the host application instead of weakening CSP.
    const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
    if (nonce) script.nonce = nonce;
    document.head.append(script);
  }).catch(error => { placesPromise = undefined; throw error; });
  return placesPromise;
}

export function addressFromGooglePlace(place: Pick<GooglePlace, 'addressComponents'>): AddressValue {
  const components = place.addressComponents ?? [];
  const find = (type: string) => components.find(component => component.types.includes(type));
  const country = find('country')?.shortText;
  const route = find('route')?.longText ?? '';
  const number = find('street_number')?.longText ?? '';
  const address = [route, number].filter(Boolean).join(' ');
  const postalCode = (find('postal_code')?.longText ?? '').replace(/\s/g, '');
  const city = find('postal_town')?.longText ?? find('locality')?.longText ?? '';
  if (country !== 'SE' || !address || !/^\d{5}$/.test(postalCode) || !city)
    throw new AddressAssistanceError('Träffen saknar en komplett svensk postadress. Fyll i adressen manuellt.', 'address_incomplete');
  return { address, postalCode, city, countryCode: 'SE' };
}
