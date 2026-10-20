import { validLuhnNumber } from './data-format';

export type CustomerIdentifierKind = 'empty' | 'incomplete' | 'organisation' | 'person' | 'coordination' | 'invalid';
export type CustomerIdentifierInspection = { kind: CustomerIdentifierKind; normalized: string; error?: string };

/** Inspect an editable Swedish identity without guessing a missing century or customer role. */
export function inspectCustomerIdentifier(value: string): CustomerIdentifierInspection {
  const cleaned = value.normalize('NFKC').trim();
  const compact = cleaned.replace(/[\s-]/g, '');
  let normalized = compact.replace(/\+/g, '');
  const invalid = (error: string): CustomerIdentifierInspection => ({ kind: 'invalid', normalized, error });
  if (!cleaned) return { kind: 'empty', normalized: '' };
  if (!/^[\d\s+-]+$/.test(cleaned) || !normalized || (compact.match(/\+/g)?.length ?? 0) > 1)
    return invalid('Använd siffror, med eller utan bindestreck eller mellanslag.');
  if (normalized.length < 10 || normalized.length === 11) return { kind: 'incomplete', normalized };
  if (normalized.length !== 10 && normalized.length !== 12)
    return invalid('Ange 10 siffror, eller 12 siffror för personnummer eller organisationsnummer med prefix 16.');

  // Prefix 16 belongs to a juridical organisation. It is not a birth century.
  const prefixedOrganisation = /^16\d{2}[2-9]\d{7}$/.test(normalized);
  if (prefixedOrganisation) normalized = normalized.slice(2);
  if (normalized.length === 10 && Number(normalized[2]) >= 2) {
    if (compact.includes('+')) return invalid('Plustecken används bara i personnummer.');
    return validLuhnNumber(normalized) ? { kind: 'organisation', normalized }
      : invalid('Organisationsnumrets kontrollsiffra stämmer inte. Kontrollera numret.');
  }

  if (compact.includes('+') && !/^(?:\d{6}|\d{8})\+\d{4}$/.test(compact))
    return invalid('Plustecknet ska stå före personnumrets fyra sista siffror.');
  const ten = normalized.slice(-10);
  const shortYear = Number(ten.slice(0, 2));
  const month = Number(ten.slice(2, 4));
  const rawDay = Number(ten.slice(4, 6));
  const coordination = rawDay >= 61 && rawDay <= 91;
  const day = coordination ? rawDay - 60 : rawDay;
  // Ten digits cannot establish a century. Validate a possible calendar date,
  // while retaining precisely the ten digits supplied for downstream handling.
  const years = normalized.length === 12 ? [Number(normalized.slice(0, 4))]
    : [1800 + shortYear, 1900 + shortYear, 2000 + shortYear, 2100 + shortYear];
  const validDate = years.some(year => {
    if (year < 1800 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  });
  if (!validDate) return invalid('Personnumret innehåller ett ogiltigt födelsedatum eller samordningsdatum.');
  if (!validLuhnNumber(ten)) return invalid('Personnumrets kontrollsiffra stämmer inte. Kontrollera numret.');
  return { kind: coordination ? 'coordination' : 'person', normalized };
}

/** Suggest a role only for a complete, validated identity. Sole traders and BRFs remain explicit choices. */
export function customerTypeFromIdentifier(value: string): 'Företag' | 'Privatperson' | undefined {
  const { kind } = inspectCustomerIdentifier(value);
  if (kind === 'organisation') return 'Företag';
  if (kind === 'person' || kind === 'coordination') return 'Privatperson';
  return undefined;
}

/** Registration assistance only. The ten-digit checksum does not establish
 * a century: choose the latest real birth date not later than Stockholm today.
 * A plus sign uses the Swedish calendar-year convention for turning 100.
 * Explicit centuries, companies and manual-only identities are never changed. */
export function completeCustomerIdentifier(value: string, now = new Date()): string {
  const inspection = inspectCustomerIdentifier(value);
  if (inspection.kind !== 'person' || inspection.normalized.length !== 10 || !Number.isFinite(now.getTime())) return value;
  // YYYYMMDD-NN is still an unfinished twelve-digit input, not YYMMDD-NNNN.
  if (!/^(?:\d{10}|\d{6}[-+]\d{4})$/.test(value.normalize('NFKC').replace(/\s/g, ''))) return value;
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find(value => value.type === name)?.value);
  const currentYear = part('year'), currentMonth = part('month'), currentDay = part('day');
  const ten = inspection.normalized, shortYear = Number(ten.slice(0, 2)), month = Number(ten.slice(2, 4)), day = Number(ten.slice(4, 6));
  const centuryYearLimit = currentYear - (value.normalize('NFKC').includes('+') ? 100 : 0);
  const today = currentYear * 10_000 + currentMonth * 100 + currentDay;
  const years = [2100, 2000, 1900, 1800].map(century => century + shortYear);
  const year = years.find(candidate => {
    if (candidate > centuryYearLimit || candidate * 10_000 + month * 100 + day > today) return false;
    const date = new Date(Date.UTC(candidate, month - 1, day));
    return date.getUTCFullYear() === candidate && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  });
  return year === undefined ? value : `${String(year).padStart(4, '0')}${ten.slice(2)}`;
}
