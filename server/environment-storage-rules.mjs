// Storage permissions are independent of hazardous-waste classification. The
// ledger is the physical stock source, including every signed correction.
const rounded = (value) => Math.round(value * 1000) / 1000;
const currentClassification = (state, articleId) => state.classifications
  .filter((record) => record.articleId === articleId).sort((left, right) => right.version - left.version)[0];
export const currentStoragePolicies = (state) => [...new Set((state.storagePolicies ?? []).map((record) => record.siteId))]
  .map((siteId) => state.storagePolicies.filter((record) => record.siteId === siteId).sort((left, right) => right.version - left.version)[0]);
export const currentEnvironmentSites = (state) => [...new Set((state.siteRecords ?? []).map((record) => record.id))]
  .map((siteId) => state.siteRecords.filter((record) => record.id === siteId).sort((left, right) => right.version - left.version)[0]);
const groupWeights = (rows, selector) => {
  const grouped = new Map();
  for (const row of rows) {
    const key = selector(row);
    if (key) grouped.set(key, rounded((grouped.get(key) ?? 0) + row.weight));
  }
  return grouped;
};
const deltaGroups = (next, previous) => new Map([...new Set([...next.keys(), ...previous.keys()])]
  .map((key) => [key, rounded((next.get(key) ?? 0) - (previous.get(key) ?? 0))]));

/** Pure assessment, called both for previews and inside the locked write
 * transaction. Previous rows are supplied only when correcting a receipt:
 * its original inventory is already included in current stock. */
export function assessEnvironmentalStorage(state, { siteId, rows, previousRows = [], checkedAt }) {
  const ledger = [...state.inventory, ...state.corrections.flatMap((record) => record.inventoryMovements)]
    .filter((record) => record.siteId === siteId);
  const articleStock = groupWeights(ledger, (row) => row.articleId);
  const codeStock = groupWeights(ledger, (row) => row.wasteCode);
  const articleDelta = deltaGroups(groupWeights(rows, (row) => row.articleId), groupWeights(previousRows, (row) => row.articleId));
  const rowCode = (row) => row.classification?.wasteCode;
  const codeDelta = deltaGroups(groupWeights(rows, rowCode), groupWeights(previousRows, rowCode));
  const currentKg = rounded(ledger.reduce((sum, row) => sum + row.weight, 0));
  const incomingKg = rounded(rows.reduce((sum, row) => sum + row.weight, 0) - previousRows.reduce((sum, row) => sum + row.weight, 0));
  const checks = [], policy = currentStoragePolicies(state).find((record) => record.siteId === siteId);
  const add = (code, severity, message, amounts, identity = {}) => checks.push({ code, severity, message, ...identity, ...amounts });
  const checkLimit = (code, message, maximum, current, incoming, identity = {}) => {
    const amounts = { currentKg: current, incomingKg: incoming, projectedKg: rounded(current + incoming), maxKg: maximum };
    if (maximum === null) {
      add(`${code}_unset`, 'warning', `${message}: ingen mängdgräns har angetts.`, amounts, identity);
    } else if (incoming > 0 && amounts.projectedKg > maximum) {
      add(`${code}_exceeded`, 'blocked', `${message}: ${amounts.projectedKg} kg efter mottagningen överskrider ${maximum} kg.`, amounts, identity);
    } else if (amounts.projectedKg > 0 && amounts.projectedKg >= maximum * 0.9) {
      add(`${code}_near`, 'warning', `${message}: ${amounts.projectedKg} av ${maximum} kg. Kontrollera kvarvarande kapacitet.`, amounts, identity);
    } else add(code, 'ok', `${message}: inom angiven gräns.`, amounts, identity);
  };

  const site = currentEnvironmentSites(state).find((record) => record.id === siteId);
  if (site?.active === false && [...articleDelta.values()].some((value) => value > 0)) add('site_inactive', 'blocked', 'Anläggningen är inaktiverad och kan inte ta emot nytt material.',
    { currentKg, incomingKg, projectedKg: rounded(currentKg + incomingKg) });
  if (!policy) add('site_policy_unconfigured', 'warning', 'Anläggningens lagringsvillkor är inte konfigurerade. Tillstånd och mängdgränser behöver kontrolleras.',
    { currentKg, incomingKg, projectedKg: rounded(currentKg + incomingKg) });
  else checkLimit('site_capacity', 'Anläggningens totala lagringsgräns', policy.totalMaxKg, currentKg, incomingKg);

  for (const [articleId, incoming] of articleDelta) {
    const classification = currentClassification(state, articleId), rules = classification?.storageRules;
    const current = articleStock.get(articleId) ?? 0, amounts = { currentKg: current, incomingKg: incoming, projectedKg: rounded(current + incoming) };
    const identity = { articleId };
    if (rules === undefined) add('article_storage_unconfigured', 'warning', 'Artikelns tillåtna lagringsplatser och mängdgränser är inte konfigurerade.', amounts, identity);
    else {
      const rule = rules.find((record) => record.siteId === siteId);
      if (!rule?.allowed) add('article_site_denied', incoming > 0 ? 'blocked' : 'warning',
        incoming > 0 ? 'Artikeln får inte tas emot eller lagras på denna anläggning.' : 'Artikelns lagringsplats är inte längre tillåten. Minskningar och uppgiftsrättelser kan registreras.', amounts, identity);
      else checkLimit('article_capacity', `Artikelns lagringsgräns på anläggningen`, rule.maxKg, current, incoming, identity);
    }
  }

  // Frozen receipt classifications govern code balances; current article rules
  // govern permissions for a new receipt/correction today.
  const positiveCodes = new Set(rows.filter((row) => (articleDelta.get(row.articleId) ?? 0) > 0).map(rowCode).filter(Boolean));
  for (const [wasteCode, incoming] of codeDelta) {
    const current = codeStock.get(wasteCode) ?? 0;
    const amounts = { currentKg: current, incomingKg: incoming, projectedKg: rounded(current + incoming) }, identity = { wasteCode };
    if (!policy) continue;
    const rule = policy.rules.find((record) => record.wasteCode === wasteCode);
    if (!rule?.allowed) add('waste_code_denied', incoming > 0 || positiveCodes.has(wasteCode) ? 'blocked' : 'warning',
      incoming > 0 || positiveCodes.has(wasteCode) ? `Avfallskod ${wasteCode} är inte tillåten i anläggningens lagringsvillkor.`
        : `Avfallskod ${wasteCode} är inte längre tillåten. Minskningar och uppgiftsrättelser kan registreras.`, amounts, identity);
    else checkLimit('waste_code_capacity', `Lagringsgräns för avfallskod ${wasteCode}`, rule.maxKg, current, incoming, identity);
  }
  if (policy && rows.some((row) => !rowCode(row))) {
    const positiveUnclassified = rows.some((row) => !rowCode(row) && (articleDelta.get(row.articleId) ?? 0) > 0);
    add('waste_code_unconfigured', positiveUnclassified ? 'blocked' : 'warning', positiveUnclassified
      ? 'Artikeln saknar avfallskod och kan inte kontrolleras mot anläggningens lagringsvillkor. Komplettera klassificeringen före mottagning eller ökad mängd.'
      : 'En eller flera befintliga artiklar saknar avfallskod. Deras mängd räknas i totalen; minskningar och uppgiftsrättelser kan registreras.',
    { currentKg, incomingKg, projectedKg: rounded(currentKg + incomingKg) });
  }
  return { siteId, canReceive: !checks.some((record) => record.severity === 'blocked'), checks, checkedAt };
}
