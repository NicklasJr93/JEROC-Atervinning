import { z } from 'zod';
import { companyLookupScope, type CompanyLookupScope } from '../../company-register/client';
import type { CompanyLogo, CompanySettings, CompanySettingsInput } from './types';

const text = z.string().max(4000);
const logoId = z.string().uuid();
const companySettingsSchema = z.object({
  companyId: z.string().min(1), organisationNumber: z.string(), version: z.number().int().nonnegative(),
  profile: z.object({ name: text, address: text, postalCode: text, city: text, countryCode: z.literal('SE'),
    phone: text, email: text, invoiceEmail: text, contactPerson: text, website: text }),
  documents: z.object({ footerText: text, logoId: logoId.optional() }),
  defaults: z.object({ paymentTermsDays: z.number().int().min(0).max(365).nullable() }),
  notifications: z.object({ customerInquiries: z.array(text).max(10), bookings: z.array(text).max(10), integrationErrors: z.array(text).max(10),
    weighedDocumentEmail: z.object({ enabled: z.boolean(), recipients: z.array(text).max(10) }).default(() => ({ enabled: false, recipients: [] })) }),
  updatedAt: z.string().optional(), capabilities: z.object({ canManage: z.boolean() }),
});
export class CompanySettingsError extends Error {
  constructor(message: string, public status = 0, public code = 'company_settings_unavailable') { super(message); }
}
export function parseCompanySettings(input: unknown): CompanySettings {
  const result = companySettingsSchema.safeParse(input);
  if (!result.success) throw new CompanySettingsError('Företagsinställningarna gav ett ofullständigt svar. Försök igen.', 502, 'company_settings_invalid_response');
  return result.data;
}
export const companyLogoUrl = (id: string) => `/api/company-settings/logos/${encodeURIComponent(id)}`;

async function request(path: string, scope: CompanyLookupScope, data?: unknown, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  try {
    const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json().catch(() => undefined);
    if (controller.signal.aborted) throw new DOMException('Avbrutet', 'AbortError');
    if (scope.platformKey !== companyLookupScope().platformKey)
      throw new CompanySettingsError('Bolaget eller kontot har ändrats. Öppna inställningarna igen.', 409, 'company_settings_scope_changed');
    if (!response.ok) throw new CompanySettingsError(typeof body?.error === 'string' ? body.error : 'Företagsinställningarna kunde inte hämtas eller sparas.', response.status,
      typeof body?.code === 'string' ? body.code : 'company_settings_unavailable');
    return body;
  } catch (failure) {
    if (timedOut) throw new CompanySettingsError('Servern svarade inte i tid. Ditt utkast finns kvar. Kontrollera de sparade uppgifterna innan du försöker igen.');
    if (controller.signal.aborted || failure instanceof CompanySettingsError) throw failure;
    throw new CompanySettingsError('Anslutningen avbröts. Ditt utkast finns kvar. Kontrollera de sparade uppgifterna innan du försöker igen.');
  } finally { globalThis.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
function scopedSettings(input: unknown, scope: CompanyLookupScope): CompanySettings {
  const value = parseCompanySettings(input);
  const expectedCompany = Object.entries(scope.headers).find(([name]) => ['x-platform-organisation-id', 'x-client-company'].includes(name.toLowerCase()))?.[1];
  if (expectedCompany && value.companyId !== expectedCompany)
    throw new CompanySettingsError('Inställningarna tillhör inte det aktiva bolaget. Öppna sidan igen.', 409, 'company_settings_scope_changed');
  return value;
}
export const companySettingsApi = {
  async read(scope: CompanyLookupScope, signal?: AbortSignal): Promise<CompanySettings> {
    return scopedSettings(await request('/api/company-settings', scope, undefined, signal), scope);
  },
  async save(value: CompanySettingsInput, scope: CompanyLookupScope, signal?: AbortSignal): Promise<CompanySettings> {
    return scopedSettings(await request('/api/company-settings', scope, value, signal), scope);
  },
  async uploadLogo(file: File, scope: CompanyLookupScope, signal?: AbortSignal): Promise<CompanyLogo> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 1024 * 1024 || file.size === 0)
      throw new CompanySettingsError('Välj en PNG-, JPG- eller WebP-bild på högst 1 MB.', 422, 'company_logo_invalid');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (signal?.aborted) throw new DOMException('Avbrutet', 'AbortError');
    let binary = '';
    for (let at = 0; at < bytes.length; at += 16384) binary += String.fromCharCode(...bytes.subarray(at, at + 16384));
    const value = await request('/api/company-settings/logo', scope, { contentType: file.type, base64: btoa(binary) }, signal) as Partial<CompanyLogo> | undefined;
    if (!value || !logoId.safeParse(value.logoId).success || value.url !== companyLogoUrl(value.logoId!))
      throw new CompanySettingsError('Loggan kunde inte läsas. Försök igen.', 502, 'company_logo_invalid_response');
    return { logoId: value.logoId!, url: value.url! };
  },
};
