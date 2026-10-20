import { test, expect } from '@playwright/test';
import { lookupCompany, CompanyLookupError } from '../src/company-register/client';

const company = {
  organisationNumber: '5593593626', name: 'Registerträff AB', address: 'Registergatan 12',
  postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', source: 'SCB', fetchedAt: '2026-10-20T08:00:00.000Z',
};

async function lookupReply(value: unknown) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    expect(input).toBe('/api/company-register/lookup');
    expect(options?.body).toBe(JSON.stringify({ organisationNumber: company.organisationNumber }));
    expect(new Headers(options?.headers).has('X-API-Key')).toBe(false);
    return new Response(JSON.stringify({ company: value }), { headers: { 'Content-Type': 'application/json' } });
  };
  try { return await lookupCompany(company.organisationNumber); }
  finally { globalThis.fetch = originalFetch; }
}

test('företagsuppslagets klient visar bara validerade kontaktuppgifter och normaliserar telefonen', async () => {
  const result = await lookupReply({ ...company, phone: '072-200 22 20', email: ' Sales.Team+SE@Example.test ', contactName: 'Får inte antas vara kontaktperson', vdEmail: 'vd@example.test' });
  expect(result).toMatchObject({ ...company, phone: '+46722002220', email: 'Sales.Team+SE@Example.test' });
  expect(result).not.toHaveProperty('contactName');
  expect(result).not.toHaveProperty('vdEmail');
});

test('saknade eller felaktiga registerkontakter lämnas utanför träffen utan att hindra företagsuppslaget', async () => {
  for (const contacts of [
    {}, { phone: null, email: null }, { phone: '', email: '  ' },
    { phone: '+460722002220', email: '<img src=x onerror=alert(1)>' },
    { phone: 722002220, email: { address: 'sales@example.test' } },
    { phone: '12345', email: 'sales@example.test\r\nBcc: attacker@example.test' },
  ]) {
    const result = await lookupReply({ ...company, ...contacts });
    expect(result).toEqual(company);
    expect(result).not.toHaveProperty('phone'); expect(result).not.toHaveProperty('email');
  }
});

test('kontaktuppgifter kan inte legitimera en registerträff för ett annat organisationsnummer', async () => {
  await expect(lookupReply({ ...company, organisationNumber: '5560000167', phone: '+46722002220', email: 'sales@example.test' }))
    .rejects.toMatchObject({ name: 'Error', code: 'company_lookup_response_invalid', status: 502 } satisfies Partial<CompanyLookupError>);
});
