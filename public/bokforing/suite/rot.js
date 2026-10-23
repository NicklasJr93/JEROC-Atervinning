// Demonstration calculations for payments made in 2026. Eligibility and the
// person's tax capacity must be reviewed; this module cannot verify either.
const MAX_CENTS = 1_000_000_000_000;
const fail = message => { throw new Error(message); };
const safe = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) fail('Beloppet måste vara positiva hela ören inom demogränsen.');
  return value;
};

export const ROT_RULES_2026 = Object.freeze({
  paymentYear: 2026,
  ratePercent: 30,
  capCents: 5_000_000,
  combinedRotRutCapCents: 7_500_000,
  reviewedAt: '2026-10-23',
});

const roundedRatio = (amount, numerator, denominator) => Number((BigInt(amount) * BigInt(numerator) * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n));
const percentage = (value, label) => {
  if (!Number.isInteger(value) || value < 0 || value > 10000) fail(`${label} ska vara 0–100 procent med högst två decimaler.`);
  return value;
};

export function calculateLineAmounts(line, vatMode = 'standard', invoiceDiscountBps = 0) {
  if (!line || typeof line.description !== 'string' || !line.description.trim() || line.description.length > 300) fail('Varje fakturarad behöver en beskrivning.');
  if (!['labor', 'material', 'other'].includes(line.kind)) fail('Välj arbete, material eller övrigt för raden.');
  if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 1_000_000) fail('Antalet måste vara positivt.');
  const hundredths = Math.round(line.quantity * 100);
  if (Math.abs(line.quantity * 100 - hundredths) > 0.000001) fail('Antalet får ha högst två decimaler.');
  safe(line.unitCents);
  if (line.unitCents <= 0) fail('À-priset måste vara större än noll.');
  if (![0, 6, 12, 25].includes(line.vatRate)) fail('Välj en momssats som demon stödjer.');
  if (!['standard', 'reverse-construction'].includes(vatMode)) fail('Välj en momstyp som demon stödjer.');
  for (const key of ['unitPriceIncludesVat', 'rotEligible']) if (line[key] !== undefined && typeof line[key] !== 'boolean') fail('Fakturaradens markeringar är ogiltiga.');
  if (line.rotEligible === true && line.kind !== 'labor') fail('Endast arbetsrader kan markeras som ROT-berättigade.');
  for (const [key, length] of [['articleNumber', 100], ['unit', 30]]) if (line[key] !== undefined && (typeof line[key] !== 'string' || line[key].length > length)) fail('Fakturaradens artikelnummer eller enhet är ogiltig.');
  const rowDiscount = percentage(line.discountBps ?? 0, 'Radrabatten');
  percentage(invoiceDiscountBps, 'Fakturarabatten');
  if (line.chargeType !== undefined) {
    if (!['freight', 'invoice-fee'].includes(line.chargeType) || line.kind !== 'other' || line.quantity !== 1 || rowDiscount !== 0 || line.rotEligible === true) fail('Frakt och fakturaavgift ska vara separata övriga rader utan rabatt eller ROT.');
  }
  const base = safe(Number((BigInt(line.unitCents) * BigInt(hundredths) + 50n) / 100n));
  if (!base) fail('Fakturaraden måste bli minst ett öre.');
  const afterRowDiscount = base - roundedRatio(base, rowDiscount, 10000);
  const amount = safe(afterRowDiscount - roundedRatio(afterRowDiscount, line.chargeType ? 0 : invoiceDiscountBps, 10000));
  const included = line.unitPriceIncludesVat === true && vatMode === 'standard';
  const netCents = included ? safe(roundedRatio(amount, 100, 100 + line.vatRate)) : amount;
  const vatCents = vatMode === 'reverse-construction' ? 0 : included ? amount - netCents : safe(roundedRatio(netCents, line.vatRate, 100));
  return { netCents, vatCents, grossCents: safe(netCents + vatCents) };
}

export function calculateRot(invoice) {
  if (!invoice?.rot) return { deductionCents: 0, laborGrossCents: 0, ratePercent: 30, capCents: ROT_RULES_2026.capCents };
  const rot = invoice.rot;
  if (invoice.vatMode !== 'standard') fail('ROT kan inte kombineras med omvänd byggmoms.');
  if (rot.paymentYear !== 2026) fail('Den här ROT-demon stödjer betalningar under 2026.');
  if (rot.eligibleConfirmed !== true) fail('Bekräfta att arbetet och kunden uppfyller ROT-villkoren före beräkning.');
  if (typeof rot.property !== 'string' || !rot.property.trim() || rot.property.length > 150) fail('Ange fastighetsbeteckning eller uppgifter om bostadsrätten.');
  if (typeof rot.personId !== 'string' || !rot.personId.trim() || rot.personId.length > 100) fail('Ange en fiktiv kundidentifierare för ROT.');
  safe(rot.availableCents);
  if (!Array.isArray(invoice.lines) || !invoice.lines.length) fail('ROT-fakturan saknar fakturarader.');
  let laborGrossCents = 0;
  for (const line of invoice.lines) {
    const amount = calculateLineAmounts(line, invoice.vatMode, invoice.invoiceDiscountBps ?? 0);
    if (line.kind === 'labor' && line.rotEligible !== false) {
      if (line.vatRate !== 25) fail('Denna ROT-demo stödjer arbetskostnad med 25 procent moms.');
      laborGrossCents = safe(laborGrossCents + amount.grossCents);
    }
  }
  if (!laborGrossCents) fail('ROT kräver en separat arbetskostnad. Material, resor och övrigt ger inget ROT-avdrag.');
  const remainingCents = rot.remainingCents === undefined ? rot.availableCents : safe(rot.remainingCents);
  // HUSFL 5 §: amounts in the request are expressed in whole kronor with
  // the öre omitted. Use the same amount on the draft invoice and claim.
  const deductionCents = Math.floor(Math.min(
    safe(Math.floor(laborGrossCents * ROT_RULES_2026.ratePercent / 100)),
    ROT_RULES_2026.capCents,
    remainingCents,
  ) / 100) * 100;
  return { deductionCents, laborGrossCents, ratePercent: 30, capCents: ROT_RULES_2026.capCents };
}
