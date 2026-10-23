// Fictional examples only; this factory never reads another application's data.
import { createEmptyState, transact, appendEntry, addActivity } from './core.js';
import { createQuote, acceptQuote, createInvoice, issueInvoice } from './sales.js';
import { createBill, bookBill, createBankEvent } from './operations.js';
import { createAsset, createPayrollRun } from './finance.js';

export const DEMO_DATE = '2026-10-23';

export function createSuiteState() {
  let state = transact(createEmptyState(), draft => {
    draft.customers.push(
      { id: 'c-maria', name: 'Maria Lind · demokund', email: 'maria@example.invalid', address: 'Exempelvägen 12, Demostaden' },
      { id: 'c-ekbacken', name: 'Ekbacken AB · demokund', email: 'ekbacken@example.invalid', address: 'Exempelgatan 4, Demostaden' },
    );
    draft.projects.push({ id: 'p-solsidan', name: 'Projekt Solsidan', customerId: 'c-maria', budgetCents: 12_000_000, status: 'active', items: [
      { id: 'pi-arbete', description: 'Snickeriarbete', kind: 'labor', quantity: 32, unitCents: 55_000, vatRate: 25 },
      { id: 'pi-material', description: 'Byggmaterial', kind: 'material', quantity: 1, unitCents: 800_000, vatRate: 25 },
      { id: 'pi-resa', description: 'Resa', kind: 'other', quantity: 1, unitCents: 80_000, vatRate: 25 },
    ] });
    draft.employees.push(
      { id: 'emp-ake', name: 'Åke Andersson · demo', payType: 'monthly', baseCents: 3_200_000, withholdingCents: 750_000, employerRateBps: 3142, active: true },
      { id: 'emp-sara', name: 'Sara Lind · demo', payType: 'hourly', baseCents: 17_500, withholdingCents: 630_000, employerRateBps: 3142, active: true },
    );
    appendEntry(draft, { date: '2026-01-01', description: 'Ingående balanser · fiktivt övningsbolag', sourceType: 'opening', sourceId: 'opening-2026', rows: [
      { account: '1930', debitCents: 50_000_000, creditCents: 0 },
      { account: '2081', debitCents: 0, creditCents: 2_500_000 },
      { account: '2091', debitCents: 0, creditCents: 47_500_000 },
    ] });
  });
  state = createInvoice(state, { customerId: 'c-ekbacken', date: '2026-10-01', dueDate: '2026-10-18', vatMode: 'standard', lines: [
    { description: 'Kontorsrenovering', kind: 'labor', quantity: 64, unitCents: 50_000, vatRate: 25 },
  ] });
  state = issueInvoice(state, state.invoices.at(-1).id);
  state = createBill(state, { supplier: 'Verktyg Norden AB · demo', number: 'VN-DEMO-2081', date: '2026-10-03', dueDate: '2026-10-28',
    netCents: 3_000_000, vatRate: 25, vatMode: 'standard', account: '5410' });
  state = bookBill(state, state.bills.at(-1).id);
  state = createAsset(state, { name: 'Kompressor · demoinventarie', date: '2026-10-05', costCents: 1_200_000, lifeMonths: 60, residualCents: 0 });
  state = createBill(state, { supplier: 'Byggmaterial Norden AB · demo', number: 'BM-DEMO-1042', date: '2026-10-22', dueDate: '2026-11-21',
    netCents: 1_000_000, vatRate: 25, vatMode: 'standard', account: '4010', projectId: 'p-solsidan' });
  state = createBill(state, { supplier: 'Montagepartner AB · demo', number: 'MP-DEMO-203', date: '2026-10-22', dueDate: '2026-11-21',
    netCents: 800_000, vatRate: 25, vatMode: 'reverse-construction', reverseConfirmed: true, account: '4425', projectId: 'p-solsidan' });
  const lines = state.projects[0].items.map(({ id, ...line }) => line);
  state = createQuote(state, { customerId: 'c-maria', projectId: 'p-solsidan', date: '2026-10-02', validUntil: '2026-11-02', lines });
  state = acceptQuote(state, state.quotes.at(-1).id);
  state = createInvoice(state, { customerId: 'c-maria', projectId: 'p-solsidan', date: DEMO_DATE, dueDate: '2026-11-22', vatMode: 'standard', lines,
    rot: { paymentYear: 2026, property: 'DEMOFASTIGHET 1:23', personId: 'DEMO-MARIA-2026', eligibleConfirmed: true, availableCents: 5_000_000 } });
  state = createPayrollRun(state, { month: '2026-10', date: '2026-10-25', hours: 160 });
  state = createBankEvent(state, { date: DEMO_DATE, description: 'Ekbacken AB · fiktiv delbetalning', amountCents: 1_000_000, account: '1930' });
  state = createBankEvent(state, { date: DEMO_DATE, description: 'Verktyg Norden AB · VN-DEMO-2081', amountCents: -3_750_000, account: '1930' });
  state = createBankEvent(state, { date: DEMO_DATE, description: 'Bankavgift · oktober · demo', amountCents: -15_000, account: '1930' });
  return transact(state, draft => addActivity(draft, 'Åkes övningsbolag är klart. Prova fakturor, ROT, bank och lön.'));
}
