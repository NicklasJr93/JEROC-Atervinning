import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../public/bokforing/suite/core.js';
import { createFxDocument, issueFxDocument, revalueFxDocument, settleFxDocument } from '../public/bokforing/suite/fx.js';
import { closeYear, getCloseChecklist, lockPeriod, fileVatPeriod } from '../public/bokforing/suite/finance.js';
import { importSie4 } from '../public/bokforing/suite/sie.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { exportYearReview, openNextYear } from '../public/bokforing/suite/financial-years.js';
import { createDeclaration } from '../public/bokforing/suite/declarations.js';
import { createCashState, createCashDocument, issueCashDocument, payCashDocument, creditCashDocument, recognizeCashYearEnd, refundCashDocument } from '../public/bokforing/suite/cash-method.js';

function fxDraft(orgNumber = '5599001236') {
  return createFxDocument(createEmptyState(), {
    side: 'customer', currency: 'EUR', number: 'DRAFT-2026',
    date: '2026-10-01', dueDate: '2026-10-31',
    partyName: 'Exempelkund', partyAddress: 'Kundgatan 1', partyPostalCode:'12345',partyCity:'Demostaden',partyCountry:'SE',performance:{mode:'invoice-date',confirmed:true},
    sellerName: 'Exempel AB', sellerAddress: 'Säljgatan 2',
    sellerOrgNumber: orgNumber, sellerVatNumber: `SE${orgNumber}01`,sellerPostalCode:'12345',sellerCity:'Demostaden',sellerCountry:'SE',
    paymentReference: 'Fakturareferens', taxTreatment: 'domestic', taxReviewed: true,
    rate: '11', rateSource: 'Granskat underlag',
    lines: [{ description: 'Utfört arbete', foreignNetMinor: 8000, vatRate: 25 }],
  });
}

test('an unissued FX draft prevents its month from locking without altering the draft', () => {
  const state = fxDraft(), before = structuredClone(state);
  assert.throws(() => lockPeriod(state, '2026-10'), /fakturautkast/i);
  assert.deepEqual(state, before);
  validateSuiteState(state);
});

test('year closing independently checks unissued FX drafts, even with all months marked locked', () => {
  const state = fxDraft();
  state.lockedPeriods = Array.from({ length: 12 }, (_, month) => `2026-${String(month + 1).padStart(2, '0')}`);
  assert.equal(getCloseChecklist(state).find(item => item.id === 'documents').done, false);
  assert.throws(() => closeYear(state, { date: '2026-12-31', confirmed: true }), /Fakturautkast/i);
  assert.equal(state.yearClosures.length, 0);
});

test('SIE result closing cannot silently turn operating profit into a zero-profit imported year', () => {
  const source = `#FLAGGA 0
#PROGRAM "Integrationstest" "1.0"
#FORMAT PC8
#GEN 20261023
#SIETYP 4
#FNAMN "Exempel AB"
#RAR 0 20260101 20261231
#VALUTA SEK
#VER A 1 20261001 "Försäljning"
{
#TRANS 1930 {} 1000.00
#TRANS 3000 {} -1000.00
}
#VER A 2 20261231 "Årets resultat"
{
#TRANS 8999 {} 1000.00
#TRANS 2099 {} -1000.00
}
`;
  const state = createEmptyState();
  assert.throws(() => importSie4(state, source, { confirmed: true }), /resultatbokning|8999/);
  assert.equal(state.entries.length, 0);
  validateSuiteState(state);
});

function close(state) {
  let next = state;
  for (let month = 1; month <= 12; month++) next = lockPeriod(next, `2026-${String(month).padStart(2, '0')}`);
  return closeYear(next, { date: '2026-12-31', confirmed: true });
}

test('year review includes FX originals, SIE source and a declaration created after its reporting period', () => {
  let state = fxDraft('5560269986');
  state.company.orgNumber = '5560269986';
  state.company.vatNumber = 'SE556026998601';
  const id = state.fxDocuments[0].id;
  state = issueFxDocument(state, id);
  state = importSie4(state, `#FLAGGA 0
#PROGRAM "Integrationstest" "1.0"
#FORMAT PC8
#GEN 20261023
#SIETYP 4
#FNAMN "Exempel AB"
#RAR 0 20260101 20261231
#VALUTA SEK
#VER A 1 20261001 "Bankkostnad"
{
#TRANS 6570 {} 10.00
#TRANS 1930 {} -10.00
}
`, { confirmed: true });
  state = revalueFxDocument(state, id, { date: '2026-12-31', rate: '12', rateSource: 'Balansdagskurs', reference: 'BALANS', reviewed: true });
  state = fileVatPeriod(state, { from: '2026-10-01', to: '2026-12-31', date: '2026-12-31' });
  state = createDeclaration(state, { kind: 'vat', orgNumber: state.company.orgNumber, from: '2026-10-01', to: '2026-12-31', reviewed: true, createdAt: '2027-02-01T10:00:00Z' });
  state = close(state);
  const beforeOpening = exportYearReview(state);
  assert.equal(beforeOpening.sourceExtensions.fxDocuments[0].id, id);
  assert.equal(beforeOpening.sourceExtensions.sieImports[0].sourceText, state.sieImports[0].sourceText);
  assert.equal(beforeOpening.sourceExtensions.declarations.length, 1);
  state = openNextYear(state, { confirmed: true });
  const archive = JSON.stringify(state.fiscalYears[0].snapshot);
  const saved = exportYearReview(state, '2026-01-01', '2026-12-31');
  assert.deepEqual(saved.sourceExtensions, beforeOpening.sourceExtensions);
  state = settleFxDocument(state, id, { date: '2027-01-10', foreignMinor: 10000, bankCents: 120000, reference: 'NEXT-YEAR' });
  assert.equal(JSON.stringify(state.fiscalYears[0].snapshot), archive);
  assert.equal(exportYearReview(state, '2026-01-01', '2026-12-31').sourceExtensions.fxEvents.length, 2);
  const downloaded = exportYearReview(state, '2026-01-01', '2026-12-31');
  downloaded.sourceExtensions.fxDocuments[0].rate.source = 'Ändrat nedladdat exemplar';
  assert.equal(JSON.stringify(state.fiscalYears[0].snapshot), archive);
  validateSuiteState(state);
});

test('cash credit evidence remains frozen in the old-year archive after a next-year refund', () => {
  let state = createCashState({ eligibilityConfirmed: true, expectedTurnoverCents: 1000000, vatPeriod: 'year' });
  state = createCashDocument(state, { side: 'customer', partyName: 'Exempelkund', partyAddress: 'Kundgatan 1', partyPostalCode:'12345',partyCity:'Demostaden',partyCountry:'SE',performance:{mode:'invoice-date',confirmed:true}, reference: 'CASH-1', date: '2026-10-01', dueDate: '2026-10-31', supplyConfirmed: true, lines: [{ description: 'Arbete', netCents: 100000, vatRate: 25 }] });
  const id = state.cashDocuments[0].id;
  state = issueCashDocument(state, id);
  state = payCashDocument(state, id, { date: '2026-10-02', amountCents: 125000, reference: 'BETALNING' });
  state = creditCashDocument(state, id, { date: '2026-10-03', amountCents: 25000, reference: 'KREDIT', reason: 'Prisnedsättning' });
  state = recognizeCashYearEnd(state, { reviewed: true });
  state = fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' });
  state = openNextYear(close(state), { confirmed: true });
  const snapshot = JSON.stringify(state.fiscalYears[0].snapshot);
  const exported = exportYearReview(state, '2026-01-01', '2026-12-31');
  assert.equal(exported.sourceExtensions.cashDocuments[0].id, id);
  assert.equal(exported.sourceExtensions.cashEvents.length, 3);
  state = refundCashDocument(state, id, { date: '2027-01-10', amountCents: 25000, reference: 'ÅTERBETALNING' });
  assert.equal(JSON.stringify(state.fiscalYears[0].snapshot), snapshot);
  assert.equal(exportYearReview(state, '2026-01-01', '2026-12-31').sourceExtensions.cashEvents.length, 3);
  validateSuiteState(state);
});
