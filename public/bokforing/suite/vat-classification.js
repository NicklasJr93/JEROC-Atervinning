// Explicit domestic exemptions. A rate of 0 alone never establishes an exemption.
// The caller must review the actual supply and all statutory conditions; this
// module records that decision and does not check licenses, contracts or registers.
import { assert } from './core.js';

export const VAT_EXEMPTION_SOURCE = 'https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/mervardesskattelag-2023200_sfs-2023-200/';
export const VAT_EXEMPTION_REASONS = Object.freeze([
  { code: 'healthcare', label: 'Sjukvård', legalBasis: '10 kap. 6–10 §§ mervärdesskattelagen (2023:200)', description: 'Medicinskt motiverad vård som uppfyller kraven på vårdgivare. Djurvård, synhjälpmedel och momspliktig bemanning omfattas inte automatiskt.' },
  { code: 'dental-care', label: 'Tandvård', legalBasis: '10 kap. 6 och 8–10 §§ mervärdesskattelagen (2023:200)', description: 'Förebyggande, utredning eller behandling av sjukdom, kroppsfel eller skada i munhålan. Granska vad leveransen faktiskt omfattar.' },
  { code: 'social-care', label: 'Social omsorg', legalBasis: '10 kap. 14 § mervärdesskattelagen (2023:200)', description: 'Omsorg som uppfyller lagens definition; all service eller bemanning är inte undantagen.' },
  { code: 'education', label: 'Utbildning som omfattas av undantag', legalBasis: '10 kap. 15–18 §§ mervärdesskattelagen (2023:200)', description: 'Granska utbildningsanordnare och utbildningens villkor. Vanlig kommersiell kurs eller föreläsning är inte automatiskt momsfri.' },
  { code: 'insurance', label: 'Försäkringstjänst', legalBasis: '10 kap. 32 § mervärdesskattelagen (2023:200)', description: 'Försäkring, återförsäkring eller sådan försäkringsförmedling som omfattas av undantaget.' },
  { code: 'financial-services', label: 'Bank- eller finansieringstjänst', legalBasis: '10 kap. 33 § mervärdesskattelagen (2023:200)', description: 'Granska tjänstens art. Inkasso, notariat, administrativa factoringtjänster och förvaringsutrymmen omfattas inte av undantaget.' },
  { code: 'property-rental', label: 'Momsfri fastighetsupplåtelse', legalBasis: '10 kap. 35–36 §§ samt 12 kap. mervärdesskattelagen (2023:200)', description: 'Granska undantagen och eventuell frivillig beskattning. Hotell, parkering och andra skattepliktiga upplåtelser omfattas inte automatiskt.' },
].map(value => Object.freeze(value)));

export function normalizeVatExemption(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    assert(!required, 'Välj och granska rättslig grund för momsfri försäljning. 0 % räcker inte.');
    return undefined;
  }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Momsundantaget har fel format.');
  const code = value.code ?? '';
  const reason = VAT_EXEMPTION_REASONS.find(item => item.code === code);
  assert(reason || !required && code === '', 'Välj ett understött svenskt momsundantag. Andra fall behöver en separat bedömning.');
  const legalBasis = value.legalBasis ?? '';
  assert(typeof legalBasis === 'string' && legalBasis.length <= 500 && !/[\u0000-\u001f]/.test(legalBasis), 'Ange hänvisning och bedömning för momsundantaget (högst 500 tecken).');
  const confirmed = value.confirmed ?? false;
  assert(typeof confirmed === 'boolean', 'Granskningen av momsundantaget har fel format.');
  if (required) {
    assert(legalBasis.trim().length >= 5, 'Ange hänvisning och bedömning för momsundantaget (5–500 tecken).');
    assert(confirmed, 'Bekräfta att affären och samtliga villkor för momsundantaget har granskats.');
  }
  return { code, legalBasis: legalBasis.trim(), confirmed };
}

export function validateVatExemption(value) {
  return normalizeVatExemption(value, { required: true });
}

export function hasVatExemption(value) {
  if (value === undefined || value === null) return false;
  validateVatExemption(value);
  return true;
}

export function vatExemptionBox(value) {
  return hasVatExemption(value) ? '42' : undefined;
}

export function vatExemptionInvoiceText(value) {
  const normalized = validateVatExemption(value);
  const reason = VAT_EXEMPTION_REASONS.find(item => item.code === normalized.code);
  return `Undantag från skatteplikt: ${reason.label}. ${reason.legalBasis}. Bedömning: ${normalized.legalBasis}`;
}
