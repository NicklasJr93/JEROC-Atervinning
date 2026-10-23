// Periodic inventory valuation for fictional demo stock. Physical movements do
// not claim to match a real purchase, delivery, bill or stock-management system.
import { transact, appendEntry, nextId, addActivity, assert, cents, validDate, requireOpenPeriod } from './core.js';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
const shortText = (value, label, maximum = 200) => {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, `Ange ${label}.`);
  return value.trim();
};
const kinds = new Set(['in', 'out', 'count']);
const ticks = (quantity, allowZero = true) => {
  assert(typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= (allowZero ? 0 : 0.01) && quantity <= 1_000_000,
    'Antalet måste vara positivt, högst 1 000 000 och ha högst två decimaler.');
  const value = Math.round(quantity * 100);
  assert(Number.isSafeInteger(value) && Math.abs(quantity * 100 - value) < 0.000001,
    'Antalet får ha högst två decimaler.');
  return value;
};
const itemValue = (item, quantity = item.quantity) => {
  const cost = cents(item.unitCostCents, false);
  return cents(Number((BigInt(cost) * BigInt(ticks(quantity)) + 50n) / 100n));
};
const sum = values => values.reduce((total, value) => cents(total + value), 0);
const signedCents = value => { cents(Math.abs(value)); return value; };
const lastValuation = state => state.inventoryValuations.at(-1);
const findItem = (state, id) => {
  const item = state.inventoryItems.find(candidate => candidate.id === id);
  assert(item, 'Lagerartikeln finns inte.');
  return item;
};
function movementAfter(before, movement) {
  const amount = ticks(movement.quantity, movement.kind === 'count');
  const after = movement.kind === 'count' ? amount : before + (movement.kind === 'in' ? amount : -amount);
  assert(after >= 0 && after <= 100_000_000, 'Lageruttaget överstiger lagersaldot eller antalet är för stort.');
  return after;
}
function quantityAt(item, date) {
  return item.movements.filter(movement => movement.date <= date).reduce((quantity, movement) => movementAfter(quantity, movement), 0) / 100;
}
function ledgerAt(state, date, accounts, excludeEntryId) {
  return state.entries.filter(entry => entry.date <= date && entry.id !== excludeEntryId).reduce((total, entry) => {
    const change = entry.rows.filter(row => accounts.includes(row.account)).reduce((n, row) => n + row.debitCents - row.creditCents, 0);
    return signedCents(total + change);
  }, 0);
}
function checkMaterialCoverage(state) {
  const changes = new Map();
  for (const entry of state.entries) {
    const change = changes.get(entry.date) ?? { expense: 0, stock: 0 };
    for (const row of entry.rows) {
      if (['4010', '4960'].includes(row.account)) change.expense = signedCents(change.expense + row.debitCents - row.creditCents);
      if (row.account === '1460') change.stock = signedCents(change.stock + row.debitCents - row.creditCents);
    }
    changes.set(entry.date, change);
  }
  let expense = 0; let stock = 0;
  for (const [, change] of [...changes].sort(([a], [b]) => a.localeCompare(b))) {
    expense = signedCents(expense + change.expense);
    stock = signedCents(stock + change.stock);
    assert(stock >= 0, 'Lagerbokföringen får inte visa ett negativt lagervärde.');
    assert(stock === 0 || expense >= 0, 'Lagervärdet saknar täckning i bokförda materialinköp. Bokför inköpet eller rätta lagervärdet först.');
  }
}

/** Shared state validator; it does not mutate, fetch data, or call validateState. */
export function validateInventoryState(state) {
  assert(Array.isArray(state.inventoryItems) && Array.isArray(state.inventoryValuations), 'Lageruppgifterna saknas.');
  const movementIds = new Set();
  for (const item of state.inventoryItems) {
    shortText(item.name, 'artikelns namn'); shortText(item.unit, 'enhet', 30); cents(item.unitCostCents, false);
    assert(Array.isArray(item.movements) && item.movements.length <= 20_000, 'Lagerartikelns rörelser är ogiltiga.');
    let current = 0; let previousDate = '';
    for (const movement of item.movements) {
      assert(identifier(movement.id) && !movementIds.has(movement.id), 'Lagerrörelsen har ett ogiltigt eller dubbelt ID.');
      movementIds.add(movement.id);
      assert(validDate(movement.date) && movement.date >= state.company.fiscalYearStart && movement.date <= state.company.fiscalYearEnd && movement.date >= previousDate,
        'Lagerrörelser ska ha giltiga datum i tidsordning inom räkenskapsåret.');
      assert(kinds.has(movement.kind), 'Välj inleverans, uttag eller inventering.');
      shortText(movement.reason, 'en orsak till lagerrörelsen');
      assert(ticks(movement.beforeQuantity) === current, 'Lagerrörelsens ingående antal stämmer inte.');
      current = movementAfter(current, movement);
      assert(ticks(movement.afterQuantity) === current, 'Lagerrörelsens utgående antal stämmer inte.');
      previousDate = movement.date;
    }
    assert(ticks(item.quantity) === current, 'Lagersaldot stämmer inte med artikelns rörelser.');
    itemValue(item);
  }
  let priorDate = '';
  for (const valuation of state.inventoryValuations) {
    assert(validDate(valuation.date) && valuation.date > priorDate && valuation.date >= state.company.fiscalYearStart && valuation.date <= state.company.fiscalYearEnd,
      'Lagervärderingar ska ha olika datum i tidsordning inom räkenskapsåret.');
    assert(Array.isArray(valuation.items), 'Lagervärderingens artikelspecifikation saknas.');
    const snapshotIds = new Set();
    for (const snapshot of valuation.items) {
      const item = findItem(state, snapshot.id);
      assert(!snapshotIds.has(item.id), 'En lagerartikel förekommer flera gånger i värderingen.');
      snapshotIds.add(item.id);
      assert(snapshot.name === item.name && snapshot.unit === item.unit && snapshot.unitCostCents === item.unitCostCents,
        'Artikeluppgifterna stämmer inte med den sparade värderingen.');
      assert(ticks(snapshot.quantity) === ticks(quantityAt(item, valuation.date)), 'Värderat antal stämmer inte med rörelserna på värderingsdagen.');
      assert(snapshot.valueCents === itemValue(item, snapshot.quantity), 'Lagervärderingens artikelbelopp stämmer inte.');
    }
    for (const item of state.inventoryItems) {
      assert(quantityAt(item, valuation.date) === 0 || snapshotIds.has(item.id), 'En artikel saknas i lagervärderingen.');
    }
    assert(valuation.valueCents === sum(valuation.items.map(item => item.valueCents)), 'Lagervärderingens totalbelopp stämmer inte.');
    const expectedDelta = signedCents(valuation.valueCents - ledgerAt(state, valuation.date, ['1460'], valuation.entryId));
    assert(valuation.deltaCents === expectedDelta, 'Lagervärderingen stämmer inte med föregående bokförda lagervärde.');
    if (expectedDelta === 0) assert(valuation.entryId === null, 'Oförändrat lagervärde ska inte skapa en verifikation.');
    else {
      const entry = state.entries.find(item => item.id === valuation.entryId);
      assert(entry && entry.sourceType === 'inventory-valuation' && entry.sourceId === valuation.id && entry.date === valuation.date,
        'Lagervärderingens verifikation saknas.');
      assert(entry.rows.length === 2 && entry.rows.every(row => ['1460', '4960'].includes(row.account)), 'Lagervärderingens konton är ogiltiga.');
      const stockChange = entry.rows.filter(row => row.account === '1460').reduce((total, row) => total + row.debitCents - row.creditCents, 0);
      assert(stockChange === expectedDelta, 'Lagervärderingens bokförda förändring stämmer inte.');
    }
    priorDate = valuation.date;
  }
  if (state.inventoryValuations.length) checkMaterialCoverage(state);
  return state;
}

export function getStockValue(state) {
  assert(Array.isArray(state.inventoryItems), 'Lagerartiklarna saknas.');
  return sum(state.inventoryItems.map(item => itemValue(item)));
}

export function createStockItem(state, { name, unit, unitCostCents }) {
  return transact(state, draft => {
    const cleanName = shortText(name, 'artikelns namn');
    const cleanUnit = shortText(unit, 'enhet', 30);
    assert(!draft.inventoryItems.some(item => item.name.toLocaleLowerCase('sv') === cleanName.toLocaleLowerCase('sv')),
      'En lagerartikel med det namnet finns redan.');
    const item = { id: nextId(draft, 'stock-item'), name: cleanName, unit: cleanUnit, unitCostCents: cents(unitCostCents, false), quantity: 0, movements: [] };
    draft.inventoryItems.push(item);
    addActivity(draft, `Lagerartikel ${item.name} skapad`, item.id);
    validateInventoryState(draft);
  });
}

export function recordStockMovement(state, id, { date, kind, quantity, reason }) {
  return transact(state, draft => {
    requireOpenPeriod(draft, date);
    const item = findItem(draft, id);
    assert(kinds.has(kind), 'Välj inleverans, uttag eller inventering.');
    const lastDate = item.movements.at(-1)?.date;
    assert(!lastDate || date >= lastDate, 'En lagerrörelse får inte dateras före artikelns senaste rörelse.');
    assert(!lastValuation(draft) || date > lastValuation(draft).date, 'En lagerrörelse får inte ändra en redan värderad dag. Välj ett senare öppet datum.');
    ticks(quantity, kind === 'count');
    const before = ticks(item.quantity);
    const after = movementAfter(before, { kind, quantity });
    const movement = { id: nextId(draft, 'stock-movement'), date, kind, quantity, beforeQuantity: before / 100, afterQuantity: after / 100, reason: shortText(reason, 'en orsak till lagerrörelsen') };
    item.movements.push(movement);
    item.quantity = after / 100;
    itemValue(item);
    addActivity(draft, `${item.name}: ${kind === 'in' ? 'inleverans' : kind === 'out' ? 'uttag' : 'inventering'} registrerad (${quantity} ${item.unit})`, item.id);
    validateInventoryState(draft);
  });
}

export function postStockValuation(state, { date }) {
  return transact(state, draft => {
    requireOpenPeriod(draft, date);
    assert(draft.inventoryItems.length > 0, 'Lägg upp en lagerartikel innan du värderar lagret.');
    assert(!lastValuation(draft) || date > lastValuation(draft).date, 'Välj ett datum efter den senaste lagervärderingen.');
    assert(draft.inventoryItems.every(item => item.movements.every(movement => movement.date <= date)), 'Värderingsdatumet ligger före en registrerad lagerrörelse.');
    const valueCents = getStockValue(draft);
    const previousValueCents = ledgerAt(draft, date, ['1460']);
    const deltaCents = signedCents(valueCents - previousValueCents);
    if (deltaCents > 0) assert(deltaCents <= ledgerAt(draft, date, ['4010', '4960']),
      'Bokför tillräckliga materialinköp före värderingsdagen. Lager får inte skapas utan bokförd anskaffning.');
    const valuation = { id: nextId(draft, 'stock-valuation'), date, valueCents, deltaCents, entryId: null,
      items: draft.inventoryItems.map(item => ({ id: item.id, name: item.name, unit: item.unit, unitCostCents: item.unitCostCents, quantity: item.quantity, valueCents: itemValue(item) })) };
    if (deltaCents) {
      const amount = Math.abs(deltaCents);
      const entry = appendEntry(draft, { date, description: 'Periodisk lagervärdering · material', sourceType: 'inventory-valuation', sourceId: valuation.id,
        rows: [{ account: '1460', debitCents: deltaCents > 0 ? amount : 0, creditCents: deltaCents < 0 ? amount : 0 },
          { account: '4960', debitCents: deltaCents < 0 ? amount : 0, creditCents: deltaCents > 0 ? amount : 0 }] });
      valuation.entryId = entry.id;
    }
    draft.inventoryValuations.push(valuation);
    addActivity(draft, `Lager värderat per ${date}: ${valueCents / 100} kr`, valuation.id);
    validateInventoryState(draft);
  });
}
