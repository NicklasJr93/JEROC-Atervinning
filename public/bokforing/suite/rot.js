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

export function calculateLineAmounts(line, vatMode = 'standard') {
  if (!line || typeof line.description !== 'string' || !line.description.trim() || line.description.length > 300) fail('Varje fakturarad behöver en beskrivning.');
  if (!['labor', 'material', 'other'].includes(line.kind)) fail('Välj arbete, material eller övrigt för raden.');
  if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 1_000_000) fail('Antalet måste vara positivt.');
  const hundredths = Math.round(line.quantity * 100);
  if (Math.abs(line.quantity * 100 - hundredths) > 0.000001) fail('Antalet får ha högst två decimaler.');
  safe(line.unitCents);
  if (line.unitCents <= 0) fail('À-priset måste vara större än noll.');
  if (![0, 6, 12, 25].includes(line.vatRate)) fail('Välj en momssats som demon stödjer.');
  const product = line.unitCents * hundredths;
  if (!Number.isSafeInteger(product)) fail('Fakturaradens belopp är för stort.');
  const netCents = safe(Math.round(product / 100));
  if (!netCents) fail('Fakturaraden måste bli minst ett öre.');
  const vatCents = vatMode === 'reverse-construction' ? 0 : safe(Math.round(netCents * line.vatRate / 100));
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
    const amount = calculateLineAmounts(line, invoice.vatMode);
    if (line.kind === 'labor') {
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
