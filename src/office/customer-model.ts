import {
  amount,
  can,
  officeSchema,
  OFFICE_WEIGHING_DEMO_VERSION,
  seedOffice,
  type OfficeAudit,
  type OfficeCard,
  type OfficeCorrection,
  type OfficeData,
  type OfficeUser,
  type PaymentDetails,
} from './model';

/** All helpers operate on the local office demo; no payment or external write occurs. */
export type ActorContext = {
  user: OfficeUser;
  actualUser?: OfficeUser;
  office?: string;
  now?: string;
  actor?: string;
};
const money = (value: number) => {
  const result = Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
  return result ? Math.sign(value) * result : 0;
};
const credited = (card: OfficeCard) =>
  ['ready', 'paid', 'balance'].includes(card.status);
const originalDelivery = (card: OfficeCard) => card.kind !== 'correction';
const digits = (value = '') => value.replace(/[\s-]/g, '');
const actorName = (context: ActorContext) =>
  context.actor ??
  (context.actualUser && context.actualUser.id !== context.user.id
    ? `${context.actualUser.name} som ${context.user.name}`
    : context.user.name);
const time = (context: ActorContext) => context.now ?? new Date().toISOString();
function audit(context: ActorContext, text: string): OfficeAudit {
  return {
    at: time(context),
    actor: actorName(context),
    text,
    actualUserId: (context.actualUser ?? context.user).id,
    effectiveUserId: context.user.id,
  };
}
function authorize(
  context: ActorContext,
  right: 'pay' | 'corrections' | 'attest',
) {
  if (!can(context.user, right))
    throw new Error('Du saknar behörighet för detta moment.');
  if (
    context.actualUser &&
    context.actualUser.id !== context.user.id &&
    context.actualUser.level !== 'Systemadmin'
  ) {
    throw new Error('Bara systemadmin får jobba som en annan användare.');
  }
}
export function paymentSummary(details?: PaymentDetails): string {
  if (!details) return '';
  switch (details.method) {
    case 'bank':
      return [
        'Bankkonto',
        details.bank,
        details.clearing,
        details.account,
        details.holder,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'swish':
      return ['Swish', details.phone, details.recipient]
        .filter(Boolean)
        .join(' · ');
    case 'cash':
      return 'Kontant';
    case 'balance':
      return 'Spara på saldo';
  }
}
export function validPaymentDetails(details?: PaymentDetails): boolean {
  if (!details) return false;
  if (details.method === 'cash' || details.method === 'balance') return true;
  if (details.method === 'bank') {
    return (
      /^\d{4,5}$/.test(digits(details.clearing)) &&
      /^\d{4,15}$/.test(digits(details.account)) &&
      Boolean(details.holder?.trim())
    );
  }
  const phone = (details.phone ?? '').replace(/[\s()\-]/g, '');
  return (
    /^(?:07\d{8}|(?:\+46|0046|46)7\d{8})$/.test(phone) &&
    Boolean(details.recipient?.trim())
  );
}
export function canSeeMoney(user: OfficeUser): boolean {
  return (
    can(user, 'reports') ||
    can(user, 'attest') ||
    can(user, 'pay') ||
    (can(user, 'priceA') &&
      can(user, 'priceB') &&
      can(user, 'priceC') &&
      can(user, 'customerPrices'))
  );
}

/** The explicitly requested demo-card reset runs once; master data is preserved. */
export function migrateOffice(input: unknown): OfficeData {
  const loaded = officeSchema.parse(input);
  const parsed = loaded.weighingDemoVersion === OFFICE_WEIGHING_DEMO_VERSION
    ? loaded
    : {
        ...loaded,
        weighingDemoVersion: OFFICE_WEIGHING_DEMO_VERSION,
        cards: seedOffice().cards,
        payments: [],
        corrections: [],
      };
  const upgradedUsers = parsed.users.map((user) => ({
    ...user,
    permissions: parsed.terminalDemoPermissionsVersion !== 1 &&
      ['kajsa', 'anna'].includes(user.id) && user.permissions.includes('view')
      ? [...new Set([...user.permissions, 'customerApprovalRead' as const])]
      : user.permissions,
  })).map((user) => {
    if (parsed.environmentPermissionsVersion === 1) return user;
    const extra = user.id === 'kajsa' && user.permissions.includes('prepare')
      ? ['environmentRead', 'environmentWrite'] as const
      : user.id === 'anna' && user.permissions.includes('view')
        ? ['environmentRead'] as const : [];
    return { ...user, permissions: [...new Set([...user.permissions, ...extra])] };
  });
  return {
    ...parsed,
    transportPermissionsVersion: 1,
    terminalDemoPermissionsVersion: 1,
    environmentPermissionsVersion: 1,
    users: parsed.transportPermissionsVersion === 0
      ? upgradedUsers.map(user => {
          // One-time upgrade of the known demo accounts; custom users retain their rights.
          const extra = user.id === 'kajsa' && user.permissions.includes('prepare')
            ? ['transportRead', 'transportPlan'] as const
            : user.id === 'anna' && user.permissions.includes('view')
              ? ['transportRead'] as const : [];
          return { ...user, permissions: [...new Set([...user.permissions, ...extra])] };
        })
      : upgradedUsers,
    cards: parsed.cards.map((card) => {
      const customer = parsed.customers.find(
        (item) => item.id === card.customerId,
      );
      const withSourceId = card.sourceId ? card : { ...card, sourceId: crypto.randomUUID() };
      const migrated =
        !card.customerSnapshot &&
        customer &&
        ['attest', 'ready', 'paid', 'balance'].includes(card.status)
          ? { ...withSourceId, customerSnapshot: structuredClone(customer) }
          : withSourceId;
      if (card.paymentDetails || !card.payment.trim()) return migrated;
      // Only the known fixture string can inherit the known fixture bank account.
      // Free text and masked real bank accounts require an explicit new selection.
      const knownBank = card.payment === 'Bankkonto · demo 8327 / ****7890';
      const paymentDetails: PaymentDetails | undefined =
        knownBank && customer?.paymentProfile
          ? { ...customer.paymentProfile }
          : /^(?:kontant)$/i.test(card.payment.trim())
            ? { method: 'cash' }
            : /^(?:spara på saldo|saldo)$/i.test(card.payment.trim())
              ? { method: 'balance' }
              : undefined;
      return paymentDetails ? { ...migrated, paymentDetails } : migrated;
    }),
    corrections: parsed.corrections.map((correction) => {
      const source = parsed.cards.find((card) => card.id === correction.cardId);
      const unitPrice =
        correction.unitPrice ??
        source?.rows.find((row) => row.articleId === correction.articleId)
          ?.price ??
        0;
      return {
        ...correction,
        serverId:
          correction.serverId ??
          `correction-${correction.cardId}-${correction.id}-${correction.at}`.slice(
            0,
            100,
          ),
        status: correction.status ?? 'draft',
        unitPrice,
        amountDelta:
          correction.amountDelta ?? money(correction.weightDelta * unitPrice),
        document: correction.document ?? '',
        office: correction.office ?? source?.yard ?? '',
        effectiveUserId:
          correction.effectiveUserId ??
          parsed.users.find((user) => user.name === correction.actor)?.id,
        audit: correction.audit ?? [
          {
            at: correction.at,
            actor: correction.actor,
            text: 'Äldre rättelseutkast bevarat vid uppdatering.',
          },
        ],
      };
    }),
  };
}

export type CustomerLedgerEntry = {
  id: string;
  date: string;
  kind: 'weighing' | 'correction' | 'payment' | 'offset';
  label: string;
  cardId: number;
  correctionId?: number;
  amount: number;
  balance: number;
  actor?: string;
  reference?: string;
  offset?: number;
};
export function customerLedger(
  data: OfficeData,
  customerId: string,
): CustomerLedgerEntry[] {
  const entries: CustomerLedgerEntry[] = [];
  for (const card of data.cards.filter(
    (item) =>
      item.customerId === customerId &&
      credited(item) &&
      !item.financialPending,
  )) {
    entries.push({
      id: `card-${card.id}`,
      date: card.date,
      kind: 'weighing',
      cardId: card.id,
      label:
        card.kind === 'correction'
          ? `Plusrättelse · viktkort #${card.id}`
          : `Viktkort #${card.id}`,
      correctionId: card.sourceCorrectionId,
      amount: amount(card),
      balance: 0,
      actor: data.users.find((user) => user.id === card.approvedBy)?.name,
    });
    // Paid cards from older versions never had a payment journal. Once a new journal
    // record exists for the card it replaces this implicit debit, never adds another.
    if (
      card.status === 'paid' &&
      !data.payments.some((payment) => payment.cardId === card.id)
    ) {
      entries.push({
        id: `legacy-payment-${card.id}`,
        date: card.paidAt ?? card.date,
        kind: 'payment',
        cardId: card.id,
        label: `Äldre demoutbetalning #${card.id}`,
        amount: -amount(card),
        balance: 0,
        reference: 'Bevarad från tidigare demoversion',
      });
    }
  }
  for (const correction of data.corrections.filter(
    (item) =>
      item.customerId === customerId &&
      item.status === 'approved' &&
      item.weightDelta < 0,
  )) {
    entries.push({
      id: `correction-${correction.id}`,
      date: correction.approvedAt ?? correction.at,
      kind: 'correction',
      cardId: correction.cardId,
      correctionId: correction.id,
      label: `Rättelse R-${correction.id} · viktkort #${correction.cardId}`,
      amount:
        correction.amountDelta ??
        money(correction.weightDelta * (correction.unitPrice ?? 0)),
      balance: 0,
      actor: correction.actor,
      reference: correction.document,
    });
  }
  for (const payment of data.payments.filter(
    (item) => item.customerId === customerId,
  )) {
    if (payment.offset > 0)
      entries.push({
        id: `${payment.id}-offset`,
        date: payment.date,
        kind: 'offset',
        cardId: payment.cardId,
        label: `Kvittning mot minussaldo · viktkort #${payment.cardId}`,
        amount: 0,
        balance: 0,
        offset: payment.offset,
        actor: payment.actor,
        reference: payment.reference,
      });
    entries.push({
      id: payment.id,
      date: payment.date,
      kind: 'payment',
      cardId: payment.cardId,
      label: `Demoutbetalning · viktkort #${payment.cardId}`,
      amount: -payment.amount,
      balance: 0,
      actor: payment.actor,
      reference: payment.reference,
    });
  }
  const ordering = { weighing: 0, correction: 1, offset: 2, payment: 3 };
  entries.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      ordering[left.kind] - ordering[right.kind] ||
      left.id.localeCompare(right.id),
  );
  let balance = 0;
  return entries.map((entry) => ({
    ...entry,
    balance: (balance = money(balance + entry.amount)),
  }));
}
export function customerBalance(data: OfficeData, customerId: string): number {
  return customerLedger(data, customerId).at(-1)?.balance ?? 0;
}

function stockholmDay(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);
}
function previousYear(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(date, lastDay)).padStart(2, '0')}`;
}
export type CustomerArticleStats = {
  articleId: string;
  weight: number;
  value: number;
  deliveryCount: number;
  lastDelivery?: string;
};
export type CustomerStats = {
  totalKg: number;
  totalValue: number;
  weighingCount: number;
  paidValue: number;
  balance: number;
  openCount: number;
  lastActivity?: string;
  previousKg: number;
  previousValue: number;
  financialPending: boolean;
  articles: CustomerArticleStats[];
  months: {
    month: string;
    label: string;
    weight: number;
    value: number;
    count: number;
  }[];
};
export function customerStats(
  data: OfficeData,
  customerId: string,
  now = new Date().toISOString(),
): CustomerStats {
  const end = stockholmDay(now);
  if (!end) throw new Error('Ogiltigt datum för kundstatistiken.');
  const start = previousYear(end);
  const previousStart = previousYear(start);
  const customerCards = data.cards.filter(
    (card) => card.customerId === customerId,
  );
  const deliveries = customerCards.filter(
    (card) =>
      originalDelivery(card) &&
      ['attest', 'ready', 'paid', 'balance'].includes(card.status),
  );
  const inPeriod = (card: OfficeCard) =>
    stockholmDay(card.date) >= start && stockholmDay(card.date) <= end;
  const current = deliveries.filter(inPeriod);
  const previous = deliveries.filter(
    (card) =>
      stockholmDay(card.date) >= previousStart &&
      stockholmDay(card.date) < start,
  );
  const map = new Map<string, CustomerArticleStats>();
  // The displayed calendar-month buckets contain exactly the selected rolling window.
  const monthMap = new Map<
    string,
    {
      month: string;
      label: string;
      weight: number;
      value: number;
      count: number;
    }
  >();
  const firstMonth =
    Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  const lastMonth = Number(end.slice(0, 4)) * 12 + Number(end.slice(5, 7)) - 1;
  for (let index = firstMonth; index <= lastMonth; index++) {
    const year = Math.floor(index / 12),
      month = index % 12;
    const key = `${year}-${String(month + 1).padStart(2, '0')}`;
    monthMap.set(key, {
      month: key,
      label: new Intl.DateTimeFormat('sv-SE', {
        month: 'short',
        year: '2-digit',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(year, month, 1))),
      weight: 0,
      value: 0,
      count: 0,
    });
  }
  let totalKg = 0,
    totalValue = 0,
    previousKg = 0,
    previousValue = 0;
  for (const card of current) {
    const month = monthMap.get(stockholmDay(card.date).slice(0, 7));
    if (month) month.count++;
    const countedArticles = new Set<string>();
    for (const row of card.rows) {
      const article = map.get(row.articleId) ?? {
        articleId: row.articleId,
        weight: 0,
        value: 0,
        deliveryCount: 0,
      };
      const value =
        card.financialPending || row.pricePending
          ? 0
          : money(row.weight * row.price);
      article.weight += row.weight;
      article.value = money(article.value + value);
      if (!countedArticles.has(row.articleId)) {
        article.deliveryCount++;
        countedArticles.add(row.articleId);
      }
      article.lastDelivery =
        !article.lastDelivery || card.date > article.lastDelivery
          ? card.date
          : article.lastDelivery;
      map.set(row.articleId, article);
      totalKg += row.weight;
      totalValue = money(totalValue + value);
      if (month) {
        month.weight += row.weight;
        month.value = money(month.value + value);
      }
    }
  }
  for (const card of previous)
    for (const row of card.rows) {
      previousKg += row.weight;
      if (!card.financialPending && !row.pricePending)
        previousValue = money(previousValue + row.weight * row.price);
    }
  for (const correction of data.corrections.filter(
    (item) => item.customerId === customerId && item.status === 'approved',
  )) {
    const original = deliveries.find((card) => card.id === correction.cardId);
    if (!original) continue;
    const value =
      correction.amountDelta ??
      money(correction.weightDelta * (correction.unitPrice ?? 0));
    // Corrections belong to the original delivery date for volumes and customer statistics.
    if (inPeriod(original)) {
      totalKg += correction.weightDelta;
      totalValue = money(totalValue + value);
      const article = map.get(correction.articleId);
      if (article) {
        article.weight += correction.weightDelta;
        article.value = money(article.value + value);
      }
      const month = monthMap.get(stockholmDay(original.date).slice(0, 7));
      if (month) {
        month.weight += correction.weightDelta;
        month.value = money(month.value + value);
      }
    } else if (previous.includes(original)) {
      previousKg += correction.weightDelta;
      previousValue = money(previousValue + value);
    }
  }
  const ledger = customerLedger(data, customerId);
  const paidValue = money(
    -ledger
      .filter(
        (entry) =>
          entry.kind === 'payment' &&
          stockholmDay(entry.date) >= start &&
          stockholmDay(entry.date) <= end,
      )
      .reduce((sum, entry) => sum + entry.amount, 0),
  );
  const activities = [
    ...customerCards.map((card) => card.date),
    ...ledger.map((entry) => entry.date),
    ...data.corrections
      .filter((item) => item.customerId === customerId)
      .map((item) => item.approvedAt ?? item.at),
  ].sort();
  return {
    totalKg: money(totalKg),
    totalValue,
    weighingCount: current.length,
    paidValue,
    balance: customerBalance(data, customerId),
    openCount: data.cards.filter(
      (card) =>
        card.customerId === customerId &&
        !['paid', 'balance'].includes(card.status),
    ).length,
    lastActivity: activities.at(-1),
    previousKg: money(previousKg),
    previousValue,
    financialPending: customerCards.some(
      (card) =>
        ['attest', 'ready', 'paid', 'balance'].includes(card.status) &&
        (card.financialPending || card.rows.some((row) => row.pricePending)),
    ),
    articles: [...map.values()]
      .map((article) => ({ ...article, weight: money(article.weight) }))
      .sort((left, right) => right.weight - left.weight),
    months: [...monthMap.values()].map((month) => ({
      ...month,
      weight: money(month.weight),
    })),
  };
}

function originalForCorrection(
  data: OfficeData,
  cardId: number,
  articleId: string,
) {
  const card = data.cards.find((item) => item.id === cardId);
  if (!card || !card.customerId || !credited(card) || !originalDelivery(card))
    throw new Error('Rättelser kräver ett attesterat originalkort med kund.');
  if (card.financialPending)
    throw new Error(
      'Invänta originalkortets låsta priser innan rättelsen skapas.',
    );
  const rows = card.rows.filter((row) => row.articleId === articleId);
  if (!rows.length || rows.some((row) => row.pricePending))
    throw new Error('Välj en artikel med verifierat pris från originalkortet.');
  if (new Set(rows.map((row) => row.price)).size > 1)
    throw new Error(
      'Artikeln har olika radpriser. Gör separata rättelser mot respektive ursprungsrad.',
    );
  return { card, rows, price: rows[0].price };
}
function validateCorrectionQuantity(
  data: OfficeData,
  correction: Pick<
    OfficeCorrection,
    'id' | 'cardId' | 'articleId' | 'weightDelta'
  >,
) {
  if (!Number.isFinite(correction.weightDelta) || correction.weightDelta === 0)
    throw new Error('Ange en viktändring som skiljer sig från noll.');
  const { card, rows, price } = originalForCorrection(
    data,
    correction.cardId,
    correction.articleId,
  );
  const currentWeight =
    rows.reduce((sum, row) => sum + row.weight, 0) +
    data.corrections
      .filter(
        (item) =>
          item.id !== correction.id &&
          item.cardId === correction.cardId &&
          item.articleId === correction.articleId &&
          item.status === 'approved',
      )
      .reduce((sum, item) => sum + item.weightDelta, 0);
  if (currentWeight + correction.weightDelta < -0.000001)
    throw new Error(
      `Rättelsen får högst ta bort ${money(currentWeight)} kg från originalkortet.`,
    );
  return { card, price };
}
export function createCorrectionDraft(
  data: OfficeData,
  input: {
    cardId: number;
    articleId: string;
    weightDelta: number;
    reason: string;
    document?: string;
  },
  context: ActorContext,
): OfficeData {
  authorize(context, 'corrections');
  const id = Math.max(0, ...data.corrections.map((item) => item.id)) + 1;
  const { card, price } = validateCorrectionQuantity(data, { ...input, id });
  const at = time(context);
  const correction: OfficeCorrection = {
    ...input,
    id,
    serverId: `correction-${crypto.randomUUID()}`,
    customerId: card.customerId!,
    actor: actorName(context),
    at,
    status: 'draft',
    unitPrice: price,
    amountDelta: money(input.weightDelta * price),
    document: input.document ?? '',
    office: context.office ?? card.yard,
    actualUserId: (context.actualUser ?? context.user).id,
    effectiveUserId: context.user.id,
    audit: [
      audit(context, `Rättelseutkast R-${id} skapat mot viktkort #${card.id}.`),
    ],
  };
  return { ...data, corrections: [...data.corrections, correction] };
}
export function submitCorrection(
  data: OfficeData,
  correctionId: number,
  context: ActorContext,
): OfficeData {
  authorize(context, 'corrections');
  const correction = data.corrections.find((item) => item.id === correctionId);
  if (!correction || (correction.status ?? 'draft') !== 'draft')
    throw new Error('Bara rättelseutkast kan skickas till attest.');
  if (!correction.reason.trim() || !correction.document?.trim())
    throw new Error('Ange orsak och hänvisning till rättelseunderlag.');
  validateCorrectionQuantity(data, correction);
  return {
    ...data,
    corrections: data.corrections.map((item) =>
      item.id === correctionId
        ? {
            ...item,
            status: 'attest',
            submittedBy: context.user.id,
            audit: [
              ...(item.audit ?? []),
              audit(context, 'Rättelsen skickad till attest.'),
            ],
          }
        : item,
    ),
  };
}
export function approveCorrection(
  data: OfficeData,
  correctionId: number,
  context: ActorContext,
): OfficeData {
  authorize(context, 'attest');
  const correction = data.corrections.find((item) => item.id === correctionId);
  if (!correction) throw new Error('Rättelsen kunde inte hittas.');
  if (correction.status === 'approved') return data;
  if (correction.status !== 'attest')
    throw new Error('Skicka rättelsen till attest först.');
  const { card, price } = validateCorrectionQuantity(data, correction);
  if (!correction.reason.trim() || !correction.document?.trim())
    throw new Error('Rättelseunderlag och orsak saknas.');
  const delta = money(correction.weightDelta * price);
  if (Math.abs(delta) > context.user.maxAttest)
    throw new Error('Rättelsen överstiger din attestgräns.');
  if (
    !context.user.ownAttest &&
    [correction.submittedBy, correction.effectiveUserId].includes(
      context.user.id,
    )
  )
    throw new Error('Du får inte attestera din egen rättelse.');
  const at = time(context);
  const resultCardId =
    correction.weightDelta > 0
      ? Math.max(0, ...data.cards.map((item) => item.id)) + 1
      : undefined;
  const approved: OfficeCorrection = {
    ...correction,
    status: 'approved',
    unitPrice: price,
    amountDelta: delta,
    approvedBy: context.user.id,
    approvedAt: at,
    resultCardId,
    audit: [
      ...(correction.audit ?? []),
      audit(
        context,
        `Rättelsen attesterad: ${correction.weightDelta > 0 ? '+' : ''}${correction.weightDelta} kg, ${delta > 0 ? '+' : ''}${delta.toFixed(2)} kr. Originalkortet bevarat.`,
      ),
    ],
  };
  const cards = resultCardId
    ? [
        ...data.cards,
        {
          id: resultCardId,
          kind: 'correction' as const,
          sourceCorrectionId: correction.id,
          customerId: card.customerId,
          status: 'ready' as const,
          yard: card.yard,
          weigher: card.weigher,
          date: at,
          reference: `Rättelse R-${correction.id} · viktkort #${card.id}`,
          origin: card.origin,
          rows: [
            {
              articleId: correction.articleId,
              weight: correction.weightDelta,
              tier: card.rows.find(
                (row) => row.articleId === correction.articleId,
              )!.tier,
              price,
              source: `Originalpris från viktkort #${card.id}`,
            },
          ],
          payment: card.payment,
          paymentDetails: card.paymentDetails
            ? { ...card.paymentDetails }
            : undefined,
          customerSnapshot: card.customerSnapshot
            ? { ...card.customerSnapshot }
            : undefined,
          idVerified: card.idVerified,
          preparedBy: correction.submittedBy ?? correction.effectiveUserId,
          approvedBy: context.user.id,
          pricingTotal: delta,
          audit: [
            audit(
              context,
              `Plusrättelse R-${correction.id} skapar separat utbetalningskort. Originalkort #${card.id} har bevarats.`,
            ),
          ],
        },
      ]
    : data.cards;
  return {
    ...data,
    cards,
    corrections: data.corrections.map((item) =>
      item.id === correctionId ? approved : item,
    ),
  };
}

export type SettlementPreview = {
  gross: number;
  offset: number;
  net: number;
  balanceBefore: number;
  balanceAfter: number;
  negativeCorrectionIds: number[];
};
function outstandingCorrectionIds(
  data: OfficeData,
  customerId: string,
  offset: number,
): number[] {
  let previouslyOffset = data.payments
    .filter((payment) => payment.customerId === customerId)
    .reduce((sum, payment) => sum + payment.offset, 0);
  let remainingOffset = offset;
  const ids: number[] = [];
  const corrections = data.corrections
    .filter(
      (correction) =>
        correction.customerId === customerId &&
        correction.status === 'approved' &&
        correction.weightDelta < 0,
    )
    .sort(
      (left, right) =>
        (left.approvedAt ?? left.at).localeCompare(
          right.approvedAt ?? right.at,
        ) || left.id - right.id,
    );
  for (const correction of corrections) {
    let remainingDebt = -Math.min(
      0,
      correction.amountDelta ??
        money(correction.weightDelta * (correction.unitPrice ?? 0)),
    );
    const consumed = Math.min(previouslyOffset, remainingDebt);
    remainingDebt = money(remainingDebt - consumed);
    previouslyOffset = money(previouslyOffset - consumed);
    if (remainingDebt > 0 && remainingOffset > 0) {
      ids.push(correction.id);
      remainingOffset = money(
        remainingOffset - Math.min(remainingOffset, remainingDebt),
      );
    }
  }
  return ids;
}
export function settlementPreview(
  data: OfficeData,
  cardId: number,
): SettlementPreview {
  const card = data.cards.find((item) => item.id === cardId);
  if (!card || !card.customerId || !credited(card))
    throw new Error('Kortet måste vara attesterat och kopplat till en kund.');
  if (
    data.cards.some(
      (item) =>
        item.customerId === card.customerId &&
        credited(item) &&
        item.financialPending,
    )
  )
    throw new Error(
      'Invänta kundens låsta ekonomiska underlag innan utbetalning.',
    );
  const gross = amount(card);
  if (!Number.isFinite(gross) || gross < 0)
    throw new Error('Kortets ekonomiska belopp är ogiltigt.');
  const balanceBefore = customerBalance(data, card.customerId);
  const existing = data.payments.find((payment) => payment.cardId === cardId);
  const alreadyPaid = card.status === 'paid';
  // Other unpaid cards are separate future settlements. Their credits cannot
  // reduce the debt deducted from this card. Offsets already registered on paid
  // cards are reflected by their smaller actual payment debit in the ledger.
  const unsettledCredits = money(
    data.cards
      .filter(
        (item) =>
          item.customerId === card.customerId &&
          ['ready', 'balance'].includes(item.status),
      )
      .reduce((sum, item) => sum + amount(item), 0),
  );
  const outstandingDebt = money(Math.max(0, unsettledCredits - balanceBefore));
  const plannedOffset = money(Math.min(gross, outstandingDebt));
  const net = existing
    ? existing.amount
    : alreadyPaid
      ? gross
      : money(gross - plannedOffset);
  const offset = existing
    ? existing.offset
    : alreadyPaid
      ? 0
      : money(gross - net);
  return {
    gross,
    net,
    offset,
    balanceBefore,
    balanceAfter: alreadyPaid ? balanceBefore : money(balanceBefore - net),
    negativeCorrectionIds:
      existing?.correctionIds ??
      outstandingCorrectionIds(data, card.customerId, offset),
  };
}
export function saveCardOnBalance(
  data: OfficeData,
  cardId: number,
  context: ActorContext,
): OfficeData {
  authorize(context, 'attest');
  const card = data.cards.find((item) => item.id === cardId);
  if (!card || card.status !== 'ready')
    throw new Error('Bara ett attesterat kort kan sparas på saldo.');
  if (card.paymentDetails?.method !== 'balance')
    throw new Error('Välj Spara på saldo innan kortet attesteras.');
  if (card.financialPending)
    throw new Error('Invänta kortets låsta ekonomiska underlag.');
  return {
    ...data,
    cards: data.cards.map((item) =>
      item.id === cardId
        ? {
            ...item,
            status: 'balance',
            audit: [
              ...item.audit,
              audit(
                context,
                'Attesterat belopp sparat på kundens saldo. Ingen utbetalning gjord.',
              ),
            ],
          }
        : item,
    ),
  };
}
export function recordPayment(
  data: OfficeData,
  cardId: number,
  context: ActorContext,
  details?: PaymentDetails,
  reference?: string,
): OfficeData {
  authorize(context, 'pay');
  const card = data.cards.find((item) => item.id === cardId);
  if (!card) throw new Error('Viktkortet kunde inte hittas.');
  if (card.status === 'paid') return data;
  if (!['ready', 'balance'].includes(card.status) || !card.customerId)
    throw new Error('Bara attesterade kort kan betalas ut.');
  if (data.payments.some((payment) => payment.cardId === cardId))
    throw new Error('En utbetalning finns redan på kortet.');
  const paymentDetails = details ?? card.paymentDetails;
  if (
    !validPaymentDetails(paymentDetails) ||
    paymentDetails!.method === 'balance'
  )
    throw new Error('Välj ett giltigt betalningssätt för utbetalningen.');
  const settlement = settlementPreview(data, cardId);
  const at = time(context),
    id = `payment-${cardId}-${data.payments.length + 1}`;
  const payment = {
    id,
    cardId,
    customerId: card.customerId,
    amount: settlement.net,
    offset: settlement.offset,
    correctionIds: [...settlement.negativeCorrectionIds],
    method: paymentDetails!.method as 'bank' | 'swish' | 'cash',
    date: at,
    reference:
      reference?.trim() || `DEMO-${cardId}-${data.payments.length + 1}`,
    actor: actorName(context),
    office: context.office ?? card.yard,
    paymentDetails: { ...paymentDetails! },
    actualUserId: (context.actualUser ?? context.user).id,
    effectiveUserId: context.user.id,
  };
  const correctionRefs = settlement.negativeCorrectionIds
    .map((correctionId) => {
      const correction = data.corrections.find(
        (item) => item.id === correctionId,
      )!;
      return `R-${correctionId} mot viktkort #${correction.cardId}`;
    })
    .join(', ');
  const text = `Demoutbetalning ${settlement.net.toFixed(2)} kr via ${paymentSummary(paymentDetails)}. Referens ${payment.reference}.${settlement.offset ? ` ${settlement.offset.toFixed(2)} kr kvittat mot minussaldo (${correctionRefs}).` : ''} Ingen banköverföring skickad.`;
  return {
    ...data,
    payments: [...data.payments, payment],
    cards: data.cards.map((item) =>
      item.id === cardId
        ? {
            ...item,
            status: 'paid',
            paidAt: at,
            audit: [...item.audit, audit(context, text)],
          }
        : item,
    ),
  };
}
