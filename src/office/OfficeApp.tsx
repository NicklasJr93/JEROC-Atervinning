import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Scale,
  Users,
  BadgeCheck,
  Wallet,
  History,
  FileText,
  LogOut,
  ArrowLeft,
  ChevronRight,
  ShieldCheck,
  Search,
  Check,
  Printer,
  Plus,
  X,
  TrendingUp,
  Download,
} from 'lucide-react';
import { initialCustomers, articleById } from '../data';
import OfficeDocument from './OfficeDocument';
import CustomerWorkspace from './CustomerWorkspace';
import PaymentEditor from './PaymentEditor';
import CorrectionsWorkspace from './CorrectionsWorkspace';
import {
  cardRoute,
  inQueue,
  workflowSections,
  safeAuditText,
} from './workflow';
import {
  migrateOffice,
  createCorrectionDraft,
  submitCorrection,
  approveCorrection,
  recordPayment,
  settlementPreview,
  paymentSummary,
  validPaymentDetails,
} from './customer-model';
import { money, kilos } from '../model';
import {
  OFFICE_VERSION,
  officeKey,
  officeSchema,
  seedOffice,
  can,
  amount,
  weight,
  statusNames,
  permissionNames,
  type OfficeData,
  type OfficeUser,
  type OfficeCard,
  type Permission,
  type OfficeCustomer,
  type PaymentDetails,
} from './model';
import PricingWorkspace from './PricingWorkspace';
import {
  pricingRequest,
  type PricingState,
  type PricingQuote,
  type PricingSnapshot,
} from './pricing-client';
import {
  QueueSummary,
  QuickActions,
  DailyWeights,
  CardPreview,
  exportOfficeCsv,
} from './OfficeOverview';
import './office.css';
const fmt = (s: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Stockholm',
  }).format(new Date(s));
const rowVisible = (u: OfficeUser, r: OfficeCard['rows'][number]) =>
  !r.pricePending &&
  can(u, 'prices') &&
  can(
    u,
    r.tier === 'Eget' ? 'customerPrices' : (`price${r.tier}` as Permission),
  );
const cardMoneyVisible = (u: OfficeUser, c: OfficeCard) =>
  !c.financialPending &&
  (can(u, 'reports') ||
    can(u, 'attest') ||
    can(u, 'pay') ||
    c.rows.every((r) => rowVisible(u, r)));
const customerName = (c: OfficeCard) =>
  c.customerSnapshot?.name ??
  initialCustomers.find((x) => x.id === c.customerId)?.name ??
  'Kund saknas';
export function OfficeApp() {
  useEffect(() => {
    const previous = document.title;
    document.title = 'JEROC · Kontoret';
    return () => {
      document.title = previous;
    };
  }, []);
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(officeKey);
      return {
        data: raw
          ? migrateOffice(JSON.parse(raw))
          : migrateOffice(seedOffice()),
        error: '',
      };
    } catch {
      return {
        data: seedOffice(),
        error:
          'Kontorsdemon kunde inte läsa sparade uppgifter. Sparandet är blockerat; återställ demon för att fortsätta.',
      };
    }
  });
  const [data, setData] = useState<OfficeData>(initial.data);
  const dataRef = useRef(data);
  dataRef.current = data;
  const [error, setError] = useState(initial.error);
  const [blocked, setBlocked] = useState(Boolean(initial.error));
  const [userId, setUserId] = useState<string | undefined>(() => {
    try {
      return sessionStorage.getItem('jeroc.office.user') ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [actingId, setActingId] = useState<string>(() => {
    try {
      return sessionStorage.getItem('jeroc.office.acting') ?? '';
    } catch {
      return '';
    }
  });
  const [previewId, setPreviewId] = useState<number | undefined>(1412);
  const [pricing, setPricing] = useState<PricingState>();
  const [priceBusy, setPriceBusy] = useState(false);
  const [pricingError, setPricingError] = useState('');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const location = useLocation(),
    navigate = useNavigate();
  const actualUser = data.users.find((u) => u.id === userId);
  const user =
    actualUser?.level === 'Systemadmin' && actingId
      ? (data.users.find((u) => u.id === actingId) ?? actualUser)
      : actualUser;
  const principalRef = useRef('');
  principalRef.current = `${actualUser?.id ?? ''}:${user?.id ?? ''}`;
  const acting = Boolean(actualUser && user && actualUser.id !== user.id);
  const auditActor = user
    ? `${acting ? `${actualUser!.name} som ` : ''}${user.name} · Kontor Norrtälje`
    : '';
  function workAs(id: string) {
    if (actualUser?.level !== 'Systemadmin') return;
    try {
      sessionStorage.setItem('jeroc.office.acting', id);
      setActingId(id);
      setSearch('');
      setMessage('');
      setPreviewId(undefined);
      navigate('/dashboard');
    } catch {
      setError('Tillåt sessionslagring för att använda Jobba som.');
    }
  }
  const section = location.pathname.split('/')[1] || 'dashboard';
  const selectedId = Number(location.pathname.split('/')[2]);
  const selected = workflowSections.includes(section)
    ? data.cards.find((c) => c.id === selectedId)
    : undefined;
  const query = new URLSearchParams(location.search);
  const historyTab = query.get('tab') === 'history';
  const selectedCustomer =
    selected?.customerSnapshot ??
    data.customers.find((c) => c.id === selected?.customerId);
  let selectedSettlement: ReturnType<typeof settlementPreview> | undefined;
  if (selected && ['ready', 'balance', 'paid'].includes(selected.status)) {
    try {
      selectedSettlement = settlementPreview(data, selected.id);
    } catch {
      /* Locked pricing must finish loading before payment. */
    }
  }
  const actorContext = user
    ? { user, actualUser, office: 'Kontor Norrtälje', actor: auditActor }
    : undefined;
  const [documentType, setDocumentType] = useState<'settlement' | 'receipt'>();
  const [payBalance, setPayBalance] = useState(false);
  useEffect(() => {
    setPayBalance(false);
    setDocumentType(undefined);
  }, [selectedId, userId, actingId]);
  useEffect(() => {
    let current = true;
    setPricing(undefined);
    if (user && actualUser && (can(user, 'prices') || can(user, 'lmeRead')))
      pricingRequest<PricingState>(
        workflowSections.includes(section) && selected
          ? `state?at=${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(selected.date))}`
          : 'state',
        user,
        actualUser,
      )
        .then((state) => {
          if (current) {
            setPricing(state);
            setPricingError('');
          }
        })
        .catch((e: Error) => {
          if (current) setPricingError(e.message);
        });
    return () => {
      current = false;
    };
  }, [userId, actingId, section, selectedId]);
  const pendingPrices = data.cards
    .filter(
      (c) =>
        c.pricingSnapshotId && (c.financialPending || c.pricingRowsPending),
    )
    .map((c) => `${c.id}:${c.pricingSnapshotId}`)
    .join(',');
  useEffect(() => {
    let current = true;
    if (!user || !actualUser || !pendingPrices) return;
    const pending = dataRef.current.cards.filter(
      (c) =>
        c.pricingSnapshotId && (c.financialPending || c.pricingRowsPending),
    );
    Promise.all(
      pending.map(async (card) => {
        const archive = await pricingRequest<{
          snapshots: (PricingQuote & { id: string })[];
        }>(`snapshots?cardId=${card.id}`, user, actualUser);
        const snapshot = archive.snapshots.find(
          (entry) => entry.id === card.pricingSnapshotId,
        );
        return { card, snapshot };
      }),
    )
      .then((results) => {
        if (!current) return;
        const live = dataRef.current;
        let changed = false;
        const cards = live.cards.map((card) => {
          const snapshot = results.find(
            (result) => result.card.id === card.id,
          )?.snapshot;
          if (
            !snapshot ||
            card.pricingSnapshotId !== snapshot.id ||
            snapshot.total == null ||
            snapshot.rows.length !== card.rows.length
          )
            return card;
          const rowsPending = snapshot.rows.some((r) => r.price == null);
          if (!card.financialPending && rowsPending) return card;
          changed = true;
          return {
            ...card,
            pricingTotal: snapshot.total,
            financialPending: false,
            pricingRowsPending: rowsPending,
            rows: snapshot.rows.map((r, i) => ({
              ...card.rows[i],
              price: r.price ?? card.rows[i].price,
              pricePending: r.price == null,
              tier: r.tier === 'Special' ? ('Eget' as const) : r.tier,
              volumeBefore: r.volumeBefore ?? card.rows[i].volumeBefore,
              volumeWithDelivery:
                r.volumeWithDelivery ?? card.rows[i].volumeWithDelivery,
              source: r.source,
            })),
          };
        });
        if (changed) persist({ ...live, cards });
      })
      .catch(() => {
        /* A restricted reader keeps financial actions locked until an authorized reader can fetch the snapshot. */
      });
    return () => {
      current = false;
    };
  }, [userId, actingId, pendingPrices]);
  function persist(next: OfficeData, force = false) {
    if (blocked && !force) return false;
    try {
      localStorage.setItem(officeKey, JSON.stringify(officeSchema.parse(next)));
      dataRef.current = next;
      setData(next);
      setError('');
      setBlocked(false);
      return true;
    } catch {
      setError(
        'Ändringen kunde inte sparas. Tillåt lokal lagring och försök igen.',
      );
      return false;
    }
  }
  function login(id: string) {
    try {
      if (!blocked && !localStorage.getItem(officeKey))
        persist(dataRef.current);
      sessionStorage.setItem('jeroc.office.user', id);
      sessionStorage.removeItem('jeroc.office.acting');
      setActingId('');
      setUserId(id);
      navigate('/dashboard');
    } catch {
      setError('Tillåt sessionslagring för att öppna demokontot.');
    }
  }
  function update(card: OfficeCard, text: string, right: Permission) {
    if (!user || !can(user, right)) return false;
    const live = dataRef.current;
    const old = live.cards.find((c) => c.id === card.id);
    if (!old || (right === 'pay' && old.financialPending)) return false;
    if (
      ['ready', 'paid', 'balance'].includes(old.status) &&
      !(right === 'pay' && old.status === 'ready' && card.status === 'paid')
    ) {
      setMessage('Kortet är låst. Ändringar ska göras genom ett rättelsekort.');
      return false;
    }
    if (
      right === 'attest' &&
      ['ready', 'balance'].includes(card.status) &&
      (old.status !== 'attest' ||
        old.financialPending ||
        amount(old) > user.maxAttest ||
        (!user.ownAttest && old.preparedBy === user.id))
    )
      return false;
    const saved = {
      ...card,
      audit: [
        ...old.audit,
        {
          at: new Date().toISOString(),
          actor: auditActor,
          actualUserId: actualUser?.id,
          effectiveUserId: user.id,
          text,
        },
      ],
    };
    return persist({
      ...live,
      cards: live.cards.map((c) => (c.id === card.id ? saved : c)),
    });
  }
  async function calculatePrices(
    card: OfficeCard,
    customerId = card.customerId,
    customerChange = false,
  ) {
    if (
      !user ||
      !actualUser ||
      !can(user, customerChange ? 'customers' : 'changePrice')
    )
      return;
    const principalId = principalRef.current;
    setPriceBusy(true);
    try {
      if (customerId && can(user, 'customers')) {
        const customer = dataRef.current.customers.find(
          (c) => c.id === customerId,
        );
        if (customer)
          await pricingRequest('customers', user, actualUser, {
            id: customer.id,
            name: customer.name,
          });
      }
      const quote = await pricingRequest<PricingQuote>(
        'quote',
        user,
        actualUser,
        {
          customerId,
          deliveredAt: card.date,
          excludeCardId: String(card.id),
          rows: card.rows.map(({ articleId, weight }) => ({
            articleId,
            weight,
          })),
        },
      );
      if (principalRef.current !== principalId) return;
      const live = dataRef.current.cards.find((c) => c.id === card.id);
      if (!live || live.audit.length !== card.audit.length) {
        setMessage(
          'Kortet ändrades under beräkningen. Beräkna priser på nytt.',
        );
        return;
      }
      const rows = quote.rows.map((r, i) => ({
        ...card.rows[i],
        price: r.price ?? card.rows[i].price,
        pricePending: r.price == null,
        tier: r.tier === 'Special' ? ('Eget' as const) : r.tier,
        volumeBefore: r.volumeBefore ?? undefined,
        volumeWithDelivery: r.volumeWithDelivery ?? undefined,
        source: r.source,
        manualOverride: false,
      }));
      update(
        {
          ...card,
          customerId,
          customerSnapshot: customerChange ? undefined : card.customerSnapshot,
          paymentDetails: customerChange
            ? dataRef.current.customers.find((c) => c.id === customerId)
                ?.paymentProfile
            : card.paymentDetails,
          payment: customerChange
            ? paymentSummary(
                dataRef.current.customers.find((c) => c.id === customerId)
                  ?.paymentProfile,
              )
            : card.payment,
          idVerified: customerChange ? false : card.idVerified,
          reference: customerChange ? '' : card.reference,
          origin: customerChange ? '' : card.origin,
          rows,
          pricedAt: card.date,
          pricingTotal: quote.total ?? undefined,
          financialPending: quote.total == null,
          pricingRowsPending: quote.rows.some((r) => r.price == null),
        },
        customerChange
          ? `Kund vald: ${dataRef.current.customers.find((c) => c.id === customerId)?.name ?? 'Kund saknas'}. Priser beräknade vid inlämningen.`
          : 'Priser räknade av servern: artikelregler, rullande 12 månader och kundundantag.',
        customerChange ? 'customers' : 'changePrice',
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Priserna kunde inte beräknas.',
      );
    } finally {
      setPriceBusy(false);
    }
  }
  async function prepareCard(card: OfficeCard) {
    if (
      !user ||
      !actualUser ||
      !can(user, 'prepare') ||
      priceBusy ||
      blocked ||
      !['new', 'complement'].includes(card.status) ||
      !card.customerId ||
      !card.idVerified ||
      !(
        validPaymentDetails(card.paymentDetails) || Boolean(card.payment.trim())
      )
    )
      return;
    const principalId = principalRef.current;
    setPriceBusy(true);
    try {
      const archive = await pricingRequest<{ snapshots: { id: string }[] }>(
        `snapshots?cardId=${card.id}`,
        user,
        actualUser,
      );
      const previousSnapshot = archive.snapshots.at(-1);
      const snapshot = await pricingRequest<PricingQuote & { id: string }>(
        'snapshots',
        user,
        actualUser,
        {
          cardId: String(card.id),
          ...(previousSnapshot
            ? { supersedesSnapshotId: previousSnapshot.id }
            : {}),
          customerId: card.customerId,
          deliveredAt: card.date,
          excludeCardId: String(card.id),
          rows: card.rows.map((r) => ({
            articleId: r.articleId,
            weight: r.weight,
            ...(can(user, 'changePrice') && (r.manualOverride || !r.source)
              ? {
                  override: {
                    price: r.price,
                    tier: r.tier,
                    reason: r.manualOverride
                      ? 'Spårbar prisändring på viktkort'
                      : 'Befintligt prissatt demounderlag',
                  },
                }
              : {}),
          })),
        },
      );
      if (principalRef.current !== principalId) return;
      const rows = snapshot.rows.map((r, i) => ({
        ...card.rows[i],
        price: r.price ?? card.rows[i].price,
        pricePending: r.price == null,
        tier:
          r.tier === 'Special'
            ? ('Eget' as const)
            : (r.tier as OfficeCard['rows'][number]['tier']),
        volumeBefore: r.volumeBefore ?? undefined,
        volumeWithDelivery: r.volumeWithDelivery ?? undefined,
        source: r.source,
      }));
      if (
        update(
          {
            ...card,
            rows,
            status: 'attest',
            preparedBy: user.id,
            customerSnapshot: dataRef.current.customers.find(
              (c) => c.id === card.customerId,
            ),
            pricingSnapshotId: snapshot.id,
            pricedAt: card.date,
            pricingTotal: snapshot.total ?? undefined,
            financialPending: snapshot.total == null,
            pricingRowsPending: snapshot.rows.some((r) => r.price == null),
          },
          'Underlaget färdigställt. Serverns prisögonblicksbild låst vid inlämningsdatum och skickat för attest.',
          'prepare',
        )
      ) {
        setMessage('Kortet väntar nu på attest.');
        navigate(
          can(user, 'attest')
            ? `/attest/${card.id}`
            : `/weighings/${card.id}?tab=history`,
        );
      }
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Underlaget kunde inte låsas.',
      );
    } finally {
      setPriceBusy(false);
    }
  }
  const editable =
    selected &&
    !['attest', 'ready', 'paid', 'balance'].includes(selected.status);
  const nav = [
    { id: 'dashboard', name: 'Översikt', icon: LayoutDashboard, right: 'view' },
    { id: 'weighings', name: 'Invägningar', icon: Scale, right: 'view' },
    { id: 'attest', name: 'Attest', icon: BadgeCheck, right: 'attest' },
    { id: 'payments', name: 'Utbetalningar', icon: Wallet, right: 'pay' },
    { id: 'customers', name: 'Kunder', icon: Users, right: 'view' },
    {
      id: 'prices',
      name: 'Artiklar & priser',
      icon: FileText,
      right: 'prices',
    },
    {
      id: 'lme',
      name: 'LME Cash',
      icon: TrendingUp,
      right: 'lmeRead',
    },
    {
      id: 'corrections',
      name: 'Rättelser',
      icon: History,
      right: 'corrections',
    },
    { id: 'users', name: 'Användare', icon: ShieldCheck, right: 'users' },
  ] as const;
  function open(id: number) {
    if (!user) return;
    const card = dataRef.current.cards.find((c) => c.id === id);
    if (!card) return;
    setMessage('');
    navigate(
      workflowSections.includes(section)
        ? `/${section}/${id}${location.search}`
        : cardRoute(card, user),
    );
  }
  const filter = query.get('status') || undefined;
  const cards = data.cards
    .filter((c) => inQueue(c, section, historyTab))
    .filter((c) => !filter || c.status === filter)
    .filter((c) =>
      `${c.id} ${c.customerSnapshot?.name ?? data.customers.find((x) => x.id === c.customerId)?.name ?? ''} ${c.reference} ${c.origin} ${c.registration ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.id - a.id);
  async function saveCustomer(customer: OfficeCustomer) {
    if (!user || !actualUser || blocked) return false;
    const previous = dataRef.current.customers.find(
      (c) => c.id === customer.id,
    );
    const contactPart = (c: OfficeCustomer) => {
      const { paymentProfile: _profile, audit: _audit, ...contact } = c;
      return JSON.stringify(contact);
    };
    const contactChanged =
      !previous || contactPart(previous) !== contactPart(customer);
    const paymentChanged =
      JSON.stringify(previous?.paymentProfile) !==
      JSON.stringify(customer.paymentProfile);
    if (
      (contactChanged && !can(user, 'customers')) ||
      (paymentChanged && !can(user, 'paymentDetails'))
    ) {
      setMessage('Du saknar behörighet för ändringen av kunduppgifterna.');
      return false;
    }
    const principal = principalRef.current;
    try {
      if (can(user, 'customers'))
        await pricingRequest('customers', user, actualUser, {
          id: customer.id,
          name: customer.name,
        });
      if (principalRef.current !== principal) return false;
      const live = dataRef.current;
      const currentCustomer = live.customers.find((c) => c.id === customer.id);
      if (
        previous &&
        JSON.stringify(currentCustomer) !== JSON.stringify(previous)
      ) {
        setMessage(
          'Kunden ändrades under sparandet. Öppna kunduppgifterna igen innan du sparar.',
        );
        return false;
      }
      const savedCustomer = {
        ...customer,
        audit: [
          ...(previous?.audit ?? []),
          {
            at: new Date().toISOString(),
            actor: auditActor,
            text:
              contactChanged && paymentChanged
                ? 'Kunduppgifter och betalningsprofil uppdaterade.'
                : paymentChanged
                  ? 'Betalningsprofil uppdaterad.'
                  : 'Kunduppgifter uppdaterade.',
            actualUserId: actualUser.id,
            effectiveUserId: user.id,
          },
        ],
      };
      return persist({
        ...live,
        customers: live.customers.some((c) => c.id === customer.id)
          ? live.customers.map((c) =>
              c.id === customer.id ? savedCustomer : c,
            )
          : [...live.customers, savedCustomer],
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Kunden kunde inte sparas.');
      return false;
    }
  }
  async function createCorrection(input: {
    cardId: number;
    articleId: string;
    weightDelta: number;
    reason: string;
    document?: string;
  }) {
    if (!actorContext || blocked) return false;
    try {
      return persist(
        createCorrectionDraft(dataRef.current, input, actorContext),
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Rättelsen kunde inte skapas.',
      );
      return false;
    }
  }
  function saveCorrectionDocument(id: number, document: string) {
    if (
      !user ||
      !actualUser ||
      !can(user, 'corrections') ||
      blocked ||
      !document.trim() ||
      document.length > 1000
    )
      return false;
    const live = dataRef.current;
    const old = live.corrections.find((c) => c.id === id);
    if (!old || (old.status ?? 'draft') !== 'draft') return false;
    const audit = {
      at: new Date().toISOString(),
      actor: auditActor,
      text: `Rättelseunderlag kompletterat: ${document.trim()}.`,
      actualUserId: actualUser.id,
      effectiveUserId: user.id,
    };
    if (
      !persist({
        ...live,
        corrections: live.corrections.map((c) =>
          c.id === id
            ? {
                ...c,
                document: document.trim(),
                audit: [...(c.audit ?? []), audit],
              }
            : c,
        ),
      })
    )
      return false;
    setMessage(
      'Rättelseunderlaget är sparat. Utkastet kan skickas för attest.',
    );
    return true;
  }
  async function sendCorrection(id: number) {
    if (!actorContext || blocked) return false;
    try {
      return persist(submitCorrection(dataRef.current, id, actorContext));
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Rättelsen kunde inte skickas.',
      );
      return false;
    }
  }
  async function approveCorrectionCard(id: number) {
    if (!actorContext || !user || !actualUser || blocked || priceBusy)
      return false;
    const live = dataRef.current;
    const principal = principalRef.current;
    try {
      const next = approveCorrection(live, id, actorContext);
      const correction = live.corrections.find((c) => c.id === id)!;
      const original = live.cards.find((c) => c.id === correction.cardId)!;
      if (correction.status === 'approved') return true;
      setPriceBusy(true);
      // The server validates the full immutable fingerprint before returning its
      // permission-filtered view, including for attesters without row-price access.
      const source = await pricingRequest<PricingSnapshot>(
        'legacy-snapshots',
        user,
        actualUser,
        {
          cardId: String(original.id),
          customerId: original.customerId,
          deliveredAt: original.date,
          preparedBy: original.preparedBy,
          rows: original.rows.map((r) => ({
            articleId: r.articleId,
            weight: r.weight,
            price: r.price,
            tier: r.tier,
          })),
        },
      );
      if (
        source.customerId !== original.customerId ||
        source.deliveredAt !== original.date ||
        source.rows.length !== original.rows.length ||
        source.rows.some(
          (row, index) =>
            row.articleId !== original.rows[index].articleId ||
            row.weight !== original.rows[index].weight ||
            (row.price != null && row.price !== original.rows[index].price),
        )
      )
        throw new Error(
          'Serverns originalunderlag skiljer sig från det låsta kortet. Rättelsen sparades inte.',
        );
      const approvedSnapshot = await pricingRequest<PricingSnapshot>(
        'approved-corrections',
        user,
        actualUser,
        {
          sourceSnapshotId: source.id,
          cardId:
            correction.serverId ??
            `correction-${correction.cardId}-${correction.id}-${correction.at}`,
          rows: [
            {
              articleId: correction.articleId,
              weightDelta: correction.weightDelta,
            },
          ],
          reason: correction.reason,
          correctedAt: correction.at,
          creatorId: correction.effectiveUserId,
          submittedBy: correction.submittedBy,
          document: correction.document,
        },
      );
      const expected = next.corrections.find((c) => c.id === id)!;
      if (
        approvedSnapshot.total !== expected.amountDelta ||
        approvedSnapshot.rows.length !== 1 ||
        approvedSnapshot.rows[0].weight !== correction.weightDelta ||
        approvedSnapshot.customerId !== correction.customerId
      )
        throw new Error(
          'Rättelsens låsta belopp stämmer inte mellan server och kundkort.',
        );
      if (principalRef.current !== principal) return false;
      if (dataRef.current !== live) {
        setMessage('Uppgifterna ändrades under granskningen. Försök igen.');
        return false;
      }
      const canonicalAudit = (entry: OfficeCard['audit'][number]) => ({
        ...entry,
        at: approvedSnapshot.at,
        actualUserId: approvedSnapshot.actor,
        effectiveUserId: approvedSnapshot.actingUser,
        actor: `${approvedSnapshot.actor !== approvedSnapshot.actingUser ? `${live.users.find((u) => u.id === approvedSnapshot.actor)?.name ?? approvedSnapshot.actor} som ` : ''}${live.users.find((u) => u.id === approvedSnapshot.actingUser)?.name ?? approvedSnapshot.actingUser} · Kontor Norrtälje`,
      });
      const canonical = {
        ...next,
        corrections: next.corrections.map((c) =>
          c.id === id
            ? {
                ...c,
                approvedBy: approvedSnapshot.approvedBy,
                approvedAt: approvedSnapshot.at,
                audit: (c.audit ?? []).map((a, i) =>
                  i === (c.audit?.length ?? 0) - 1 ? canonicalAudit(a) : a,
                ),
              }
            : c,
        ),
        cards: next.cards.map((c) =>
          c.sourceCorrectionId === id
            ? {
                ...c,
                approvedBy: approvedSnapshot.approvedBy,
                date: approvedSnapshot.at,
                audit: c.audit.map(canonicalAudit),
              }
            : c,
        ),
      };
      return persist(canonical);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Rättelsen kunde inte godkännas.',
      );
      return false;
    } finally {
      setPriceBusy(false);
    }
  }
  function payCard(card: OfficeCard, details?: PaymentDetails) {
    if (!actorContext || blocked) return false;
    try {
      const preview = settlementPreview(dataRef.current, card.id);
      if (
        !window.confirm(
          `Registrera en DEMOutbetalning på ${money(preview.net)} kr? Kvittning ${money(preview.offset)} kr. Ingen betalning skickas.`,
        )
      )
        return false;
      if (
        !persist(recordPayment(dataRef.current, card.id, actorContext, details))
      )
        return false;
      setMessage(
        'Demoutbetalningen är registrerad med underlag. Ingen betalning skickades.',
      );
      navigate(`/payments/${card.id}?tab=history`);
      setPayBalance(false);
      return true;
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : 'Utbetalningen kunde inte registreras.',
      );
      return false;
    }
  }
  const pricingAccess =
    user &&
    (can(user, 'prices') ||
      can(user, 'articlesEdit') ||
      can(user, 'customerPrices') ||
      can(user, 'customerPriceEdit'));
  const allowed =
    section === 'corrections' &&
    user &&
    (can(user, 'corrections') || can(user, 'attest'))
      ? undefined
      : section === 'weighings'
        ? 'view'
        : section === 'prices' && pricingAccess
          ? undefined
          : nav.find((n) => n.id === section)?.right;
  if (!user)
    return (
      <div className="office office-login">
        <div className="office-login-card">
          <img src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" />
          <span className="office-eyebrow">
            KONTORET · DEMO {OFFICE_VERSION}
          </span>
          <h1>Välkommen till kontoret</h1>
          <p>
            Prova arbetsflödet med ett demokonto. Uppgifterna sparas bara i den
            här webbläsaren.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="office-demo-users">
            {data.users.map((u) => (
              <button key={u.id} onClick={() => login(u.id)}>
                <span className="office-avatar">
                  {u.name
                    .split(' ')
                    .map((n) => n[0])
                    .join('')
                    .slice(0, 2)}
                </span>
                <span>
                  <strong>{u.name}</strong>
                  <small>
                    {u.level} ·{' '}
                    {can(u, 'attest')
                      ? `Attest upp till ${money(u.maxAttest)} kr`
                      : 'Granskning och komplettering'}
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            ))}
          </div>
          <p className="office-small">
            Ingen riktig inloggning, bankkoppling eller synkning med mobilappen
            ännu.
          </p>
          <a href="/">Öppna gårdsappen</a>
        </div>
      </div>
    );
  return (
    <div className="office">
      <aside className="office-sidebar">
        <img
          className="office-logo"
          src="/images/jeroc-logo-v2.png"
          alt="JEROC Återvinning"
        />
        <span className="office-eyebrow">KONTORSÖVERSIKT</span>
        <nav>
          {nav
            .filter((n) =>
              n.id === 'prices'
                ? pricingAccess
                : n.id === 'corrections'
                  ? can(user, 'corrections') || can(user, 'attest')
                  : can(user, n.right),
            )
            .map((n) => (
              <button
                className={section === n.id ? 'active' : ''}
                key={n.id}
                onClick={() => {
                  setSearch('');
                  setMessage('');
                  navigate(`/${n.id}`);
                }}
              >
                <n.icon size={19} />
                {n.name}
                {n.id === 'attest' && (
                  <span>
                    {data.cards.filter((c) => c.status === 'attest').length}
                  </span>
                )}
              </button>
            ))}
        </nav>
        <div className="office-sidebar-bottom">
          <span className="office-online">● Kontorsdemo {OFFICE_VERSION}</span>
          <p>Norrtälje · Alla uppgifter är fiktiva</p>
          <button
            onClick={() => {
              sessionStorage.removeItem('jeroc.office.user');
              sessionStorage.removeItem('jeroc.office.acting');
              setActingId('');
              setUserId(undefined);
              setSearch('');
            }}
          >
            <LogOut size={17} />
            Byt demokonto
          </button>
        </div>
      </aside>
      <div className="office-workspace">
        <header className="office-topbar">
          <span>
            Kontoret <ChevronRight size={14} />{' '}
            {nav.find((n) => n.id === section)?.name ?? 'Vägning'}
          </span>
          <label className="office-search">
            <Search size={17} />
            <input
              aria-label="Sök vägning, kund eller referens"
              placeholder="Sök vägning, kund eller referens…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (section === 'dashboard') navigate('/weighings?tab=history');
              }}
            />
          </label>
          {actualUser?.level === 'Systemadmin' && (
            <label className="office-work-as">
              Jobba som
              <select
                aria-label="Jobba som"
                value={acting ? user.id : ''}
                onChange={(e) => workAs(e.target.value)}
              >
                <option value="">Systemadmin · egen behörighet</option>
                {data.users
                  .filter((u) => u.id !== actualUser.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="office-user">
            <span className="office-avatar">
              {user.name
                .split(' ')
                .map((n) => n[0])
                .join('')
                .slice(0, 2)}
            </span>
            <span>
              <strong>{user.name}</strong>
              <small>{user.level} · Norrtälje</small>
            </span>
          </div>
        </header>
        <div className="office-demo-notice">
          Demo · Inga riktiga betalningar eller kontorsöverföringar · Separat
          från gårdsappens lokala data
        </div>
        {acting && (
          <div className="office-acting-banner" role="status">
            <ShieldCheck size={17} />
            <span>
              <strong>Jobbar som {user.name}</strong> · {user.level}
              {can(user, 'attest')
                ? ` · Attestgräns ${money(user.maxAttest)} kr`
                : ''}
              <small>
                Inloggad som {actualUser!.name}. Åtgärder sparar båda namnen i
                historiken.
              </small>
            </span>
            <button onClick={() => workAs('')}>
              Avsluta Jobba som <X size={14} />
            </button>
          </div>
        )}
        <main className="office-main">
          {error && (
            <div className="office-alert" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="office-message" role="status">
              {message}
              <button
                onClick={() => setMessage('')}
                aria-label="Stäng meddelande"
              >
                <X size={15} />
              </button>
            </div>
          )}
          {allowed && typeof allowed === 'string' && !can(user, allowed) ? (
            <section className="office-panel">
              <h1>Behörighet saknas</h1>
              <p>Ditt konto har inte åtkomst till denna vy.</p>
            </section>
          ) : selected && workflowSections.includes(section) ? (
            <>
              <button
                className="office-back"
                onClick={() => navigate(`/${section}${location.search}`)}
              >
                <ArrowLeft size={16} />
                {section === 'attest'
                  ? 'Till attest'
                  : section === 'payments'
                    ? 'Till utbetalningar'
                    : 'Till invägningar'}
              </button>
              <div className="office-title">
                <div>
                  <span className="office-eyebrow">
                    UNDERLAG FRÅN GÅRDSPLAN · {selected.yard}
                  </span>
                  <h1>Invägning #{selected.id}</h1>
                  <p>
                    {selected.weigher} · Inlämnat {fmt(selected.date)}
                    {selected.registration
                      ? ` · Fordonsvåg ${selected.registration}`
                      : ''}
                  </p>
                </div>
                <Status status={selected.status} />
              </div>
              {pricingError && editable && (
                <div className="office-alert" role="alert">
                  {pricingError}
                </div>
              )}
              <div className="office-detail-grid">
                <div>
                  <section className="office-panel">
                    <div className="office-panel-heading">
                      <h2>Material & prissättning</h2>
                      <strong>{kilos(weight(selected))} kg</strong>
                      {editable && can(user, 'changePrice') && (
                        <button
                          className="office-link"
                          disabled={priceBusy || !selected.customerId}
                          onClick={() => calculatePrices(selected)}
                        >
                          Beräkna priser
                        </button>
                      )}
                    </div>
                    <div className="office-info">
                      Prisdatum {fmt(selected.date)} ·{' '}
                      {selected.pricingSnapshotId
                        ? 'Låst prisögonblicksbild'
                        : 'Serverns artikelregler och kundpriser'}
                    </div>
                    <div className="office-table-wrap">
                      <table className="office-table">
                        <thead>
                          <tr>
                            <th>Material</th>
                            <th>Vikt</th>
                            {can(user, 'prices') && (
                              <>
                                <th>Volym 12 mån</th>
                                <th>Prisregel</th>
                                <th>kr/kg</th>
                                <th>Belopp</th>
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {selected.rows.map((r, i) => (
                            <tr key={i}>
                              <td>
                                <span className="office-material">
                                  <MaterialImage id={r.articleId} />
                                  {articleById(r.articleId).name}
                                </span>
                              </td>
                              <td>{kilos(r.weight)} kg</td>
                              {can(user, 'prices') && (
                                <>
                                  <td>
                                    {!can(user, 'customerPrices') ||
                                    r.volumeWithDelivery == null
                                      ? '–'
                                      : `${kilos(r.volumeWithDelivery)} kg`}
                                    <small>
                                      {!can(user, 'customerPrices')
                                        ? 'Kundprisbehörighet krävs'
                                        : r.volumeBefore == null
                                          ? 'Beräkna för volymunderlag'
                                          : `Före: ${kilos(r.volumeBefore)} kg`}
                                    </small>
                                  </td>
                                  <td>
                                    <span className="office-rule">
                                      {rowVisible(user, r)
                                        ? r.tier === 'Eget'
                                          ? r.manualOverride
                                            ? 'Engångspris'
                                            : 'Kundpris'
                                          : `${r.tier}-pris`
                                        : 'Dolt pris'}
                                    </span>
                                    <small>
                                      {rowVisible(user, r)
                                        ? (r.source ?? 'Befintligt underlag')
                                        : 'Behörighet saknas'}
                                    </small>
                                  </td>
                                  <td>
                                    {rowVisible(user, r) ? money(r.price) : '–'}
                                  </td>
                                  <td>
                                    {rowVisible(user, r)
                                      ? money(r.weight * r.price)
                                      : '–'}
                                  </td>
                                </>
                              )}
                              {(editable || selected.status === 'attest') &&
                                can(user, 'changePrice') &&
                                rowVisible(user, r) && (
                                  <td>
                                    <PriceEditor
                                      row={r}
                                      disabled={priceBusy}
                                      user={user}
                                      rates={
                                        pricing?.articles.find(
                                          (a) => a.id === r.articleId,
                                        )?.prices
                                      }
                                      onSave={(tier, price) =>
                                        update(
                                          {
                                            ...selected,
                                            status:
                                              selected.status === 'attest'
                                                ? 'complement'
                                                : selected.status,
                                            pricingTotal: undefined,
                                            financialPending: false,
                                            pricingRowsPending: false,
                                            rows: selected.rows.map((x, j) =>
                                              j === i
                                                ? {
                                                    ...x,
                                                    tier,
                                                    price,
                                                    manualOverride: true,
                                                    pricePending: false,
                                                    source:
                                                      'Manuellt engångsval',
                                                  }
                                                : x,
                                            ),
                                          },
                                          `Pris för ${articleById(r.articleId).name} ändrat från ${r.tier} ${money(r.price)} till ${tier} ${money(price)} kr/kg.`,
                                          'changePrice',
                                        )
                                      }
                                    />
                                  </td>
                                )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {selected.gross != null && (
                      <div className="office-scale-facts">
                        <span>
                          Infart<strong>{kilos(selected.gross)} kg</strong>
                        </span>
                        <span>
                          Utfart<strong>{kilos(selected.tare ?? 0)} kg</strong>
                        </span>
                        <span>
                          Nettovikt före avdrag
                          <strong>
                            {kilos(selected.gross - (selected.tare ?? 0))} kg
                          </strong>
                        </span>
                        <span>
                          Avdrag
                          <strong>{kilos(selected.deduction ?? 0)} kg</strong>
                        </span>
                        <span>
                          Materialvikt
                          <strong>{kilos(weight(selected))} kg</strong>
                        </span>
                      </div>
                    )}
                  </section>
                  <section className="office-panel">
                    <h2>Spårbarhet</h2>
                    <div className="office-process-trace">
                      {selected.preparedBy && (
                        <span>
                          Förberett av{' '}
                          <strong>
                            {data.users.find(
                              (u) => u.id === selected.preparedBy,
                            )?.name ?? selected.preparedBy}
                          </strong>
                        </span>
                      )}
                      {selected.approvedBy && (
                        <span>
                          Attesterat av{' '}
                          <strong>
                            {data.users.find(
                              (u) => u.id === selected.approvedBy,
                            )?.name ?? selected.approvedBy}
                          </strong>
                        </span>
                      )}
                      {data.payments
                        .filter((p) => p.cardId === selected.id)
                        .map((p) => (
                          <span key={p.id}>
                            Utbetalt av <strong>{p.actor}</strong>
                            <small>
                              {fmt(p.date)} · {p.reference}
                            </small>
                          </span>
                        ))}
                    </div>
                    <ol className="office-audit">
                      {selected.audit
                        .filter(
                          (a) =>
                            !a.text.startsWith('Pris för') ||
                            can(user, 'changePrice'),
                        )
                        .slice()
                        .reverse()
                        .map((a, i) => (
                          <li key={i}>
                            <i />
                            <div>
                              <strong>{safeAuditText(user, a.text)}</strong>
                              <small>
                                {a.actor} · {fmt(a.at)}
                              </small>
                            </div>
                          </li>
                        ))}
                    </ol>
                  </section>
                </div>
                <div>
                  <section className="office-panel">
                    <h2>Kund, referens & ursprung</h2>
                    <label>
                      Kund
                      <select
                        aria-label="Kund på vägningen"
                        disabled={
                          priceBusy || !editable || !can(user, 'customers')
                        }
                        value={selected.customerId ?? ''}
                        onChange={(e) => {
                          if (e.target.value)
                            calculatePrices(selected, e.target.value, true);
                          else
                            update(
                              {
                                ...selected,
                                customerId: undefined,
                                customerSnapshot: undefined,
                                reference: '',
                                origin: '',
                                paymentDetails: undefined,
                                payment: '',
                                idVerified: false,
                              },
                              'Kund borttagen från underlaget.',
                              'customers',
                            );
                        }}
                      >
                        <option value="">Välj kund</option>
                        {data.customers.map((c) => (
                          <option value={c.id} key={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selected.customerId && (
                      <div className="office-customer-contact">
                        <span className="office-customer-symbol">
                          <Users size={22} />
                        </span>
                        <div>
                          <strong>
                            {selectedCustomer?.name ?? customerName(selected)}
                          </strong>
                          <small>
                            {selectedCustomer?.number} ·{' '}
                            {selectedCustomer?.type}
                          </small>
                        </div>
                        <dl>
                          <dt>Telefon</dt>
                          <dd>{selectedCustomer?.phone || '–'}</dd>
                          <dt>E-post</dt>
                          <dd>{selectedCustomer?.email || '–'}</dd>
                        </dl>
                      </div>
                    )}
                    <DetailFields
                      key={`${selected.id}-${selected.customerId}`}
                      card={selected}
                      customer={selectedCustomer}
                      disabled={priceBusy || !editable || !can(user, 'prepare')}
                      save={(reference, origin) =>
                        update(
                          { ...selected, reference, origin },
                          'Referens och ursprung uppdaterade.',
                          'prepare',
                        )
                      }
                    />
                  </section>
                  <section className="office-panel">
                    <h2>Utbetalning & ID</h2>
                    {can(user, 'paymentDetails') ||
                    can(user, 'pay') ||
                    can(user, 'attest') ? (
                      <PaymentEditor
                        key={`${selected.id}-${selected.customerId}`}
                        value={selected.paymentDetails}
                        legacy={selected.payment}
                        customerName={selectedCustomer?.name}
                        disabled={
                          priceBusy || !editable || !can(user, 'paymentDetails')
                        }
                        onSave={(paymentDetails) =>
                          update(
                            {
                              ...selected,
                              paymentDetails,
                              payment: paymentSummary(paymentDetails),
                            },
                            'Betalningssätt och betalningsuppgifter sparade.',
                            'paymentDetails',
                          )
                        }
                      />
                    ) : (
                      <p>
                        {selected.payment
                          ? 'Betalningsuppgifter finns'
                          : 'Betalningsuppgifter saknas'}
                      </p>
                    )}
                    <div
                      className={`office-id ${selected.idVerified ? 'ok' : ''}`}
                    >
                      <ShieldCheck size={20} />
                      {selected.idVerified
                        ? 'ID kontrollerat'
                        : 'ID behöver kontrolleras'}
                    </div>
                    {editable &&
                      can(user, 'verifyId') &&
                      !selected.idVerified && (
                        <button
                          className="office-btn outline"
                          disabled={priceBusy}
                          onClick={() =>
                            update(
                              { ...selected, idVerified: true },
                              'Legitimation kontrollerad manuellt och ID markerat verifierat.',
                              'verifyId',
                            )
                          }
                        >
                          Verifiera ID
                        </button>
                      )}
                  </section>
                  <section className="office-panel">
                    <h2>Sammanställning</h2>
                    {selected.financialPending && (
                      <p className="office-small">
                        Beloppet finns i serverns prisunderlag. En användare med
                        ekonomibehörighet behöver läsa in det före attest och
                        utbetalning.
                      </p>
                    )}
                    {cardMoneyVisible(user, selected) ? (
                      <div className="office-total">
                        <span>Att betala ut</span>
                        <strong>{money(amount(selected))} kr</strong>
                      </div>
                    ) : (
                      <p>
                        {kilos(weight(selected))} kg · {selected.rows.length}{' '}
                        material
                      </p>
                    )}
                    {editable && can(user, 'prepare') && (
                      <button
                        className="office-btn"
                        disabled={
                          priceBusy ||
                          !selected.customerId ||
                          !selected.idVerified ||
                          !selected.payment
                        }
                        onClick={() => prepareCard(selected)}
                      >
                        Skicka för attest <ChevronRight size={16} />
                      </button>
                    )}
                    {editable &&
                      (!selected.customerId ||
                        !selected.idVerified ||
                        !selected.payment) && (
                        <p className="office-small">
                          Välj kund, kontrollera ID och fyll i
                          betalningsuppgifter före attest.
                        </p>
                      )}
                    {selected.status === 'attest' && can(user, 'attest') && (
                      <>
                        <p className="office-small">
                          Din attestgräns: {money(user.maxAttest)} kr
                        </p>
                        <button
                          className="office-btn"
                          disabled={
                            selected.financialPending ||
                            amount(selected) > user.maxAttest ||
                            (!user.ownAttest && selected.preparedBy === user.id)
                          }
                          onClick={() => {
                            if (
                              update(
                                {
                                  ...selected,
                                  status:
                                    selected.paymentDetails?.method ===
                                    'balance'
                                      ? 'balance'
                                      : 'ready',
                                  approvedBy: user.id,
                                },
                                selected.paymentDetails?.method === 'balance'
                                  ? 'Kortet attesterat. Beloppet sparat på kundens saldo.'
                                  : 'Kortet attesterat och klart för utbetalning.',
                                'attest',
                              )
                            ) {
                              setMessage(
                                selected.paymentDetails?.method === 'balance'
                                  ? 'Attesterat. Beloppet ligger på kundens saldo.'
                                  : 'Attesterat. Kortet ligger under Utbetalningar.',
                              );
                              navigate(
                                selected.paymentDetails?.method === 'balance'
                                  ? `/payments/${selected.id}?tab=history`
                                  : can(user, 'pay')
                                    ? `/payments/${selected.id}`
                                    : `/attest/${selected.id}?tab=history`,
                              );
                            }
                          }}
                        >
                          Attestera
                        </button>
                        {amount(selected) > user.maxAttest && (
                          <div className="office-alert">
                            Beloppet överstiger din attestgräns. En användare
                            med högre gräns behöver attestera.
                          </div>
                        )}
                        {!user.ownAttest && selected.preparedBy === user.id && (
                          <p>
                            Du får inte attestera ett kort du själv förberett.
                          </p>
                        )}
                        <button
                          className="office-btn outline"
                          onClick={() =>
                            update(
                              { ...selected, status: 'complement' },
                              'Returnerat för komplettering.',
                              'attest',
                            )
                          }
                        >
                          Returnera för komplettering
                        </button>
                      </>
                    )}
                    {['ready', 'balance'].includes(selected.status) &&
                      can(user, 'pay') &&
                      selectedSettlement && (
                        <>
                          <div className="office-settlement">
                            <span>
                              Viktkortets belopp{' '}
                              <strong>{money(amount(selected))} kr</strong>
                            </span>
                            <span>
                              Kvittning av minussaldo{' '}
                              <strong>
                                −{money(selectedSettlement.offset)} kr
                              </strong>
                            </span>
                            {selectedSettlement.negativeCorrectionIds.length >
                              0 && (
                              <small>
                                Rättelser{' '}
                                {selectedSettlement.negativeCorrectionIds
                                  .map((id) => `R-${id}`)
                                  .join(', ')}
                              </small>
                            )}
                            <span>
                              Att betala ut{' '}
                              <strong>
                                {money(selectedSettlement.net)} kr
                              </strong>
                            </span>
                          </div>
                          {selected.status === 'ready' && (
                            <button
                              className="office-btn"
                              disabled={selected.financialPending || priceBusy}
                              onClick={() => payCard(selected)}
                            >
                              Registrera demoutbetalning
                            </button>
                          )}

                          {selected.status === 'balance' && !payBalance && (
                            <button
                              className="office-btn"
                              onClick={() => setPayBalance(true)}
                            >
                              Betala ut från saldo
                            </button>
                          )}
                          {selected.status === 'balance' && payBalance && (
                            <PaymentEditor
                              allowBalance={false}
                              customerName={selectedCustomer?.name}
                              value={
                                data.customers.find(
                                  (c) => c.id === selected.customerId,
                                )?.paymentProfile
                              }
                              buttonLabel="Registrera utbetalning"
                              onSave={(details) => payCard(selected, details)}
                            />
                          )}
                        </>
                      )}
                    {['ready', 'paid', 'balance'].includes(selected.status) && (
                      <>
                        <p className="office-lock">
                          <ShieldCheck size={16} />
                          Låst underlag · ändringar kräver rättelsekort
                        </p>
                        <button
                          className="office-btn outline"
                          disabled={!cardMoneyVisible(user, selected)}
                          onClick={() => setDocumentType('settlement')}
                        >
                          <Printer size={16} />
                          Avräkningsnota
                        </button>
                        {selected.status === 'paid' && (
                          <button
                            className="office-btn outline"
                            disabled={!cardMoneyVisible(user, selected)}
                            onClick={() => setDocumentType('receipt')}
                          >
                            <Printer size={16} />
                            Utbetalningskvitto
                          </button>
                        )}
                      </>
                    )}
                  </section>
                  {['ready', 'paid', 'balance'].includes(selected.status) &&
                    can(user, 'corrections') && (
                      <CorrectionForm
                        card={selected}
                        onSave={async (
                          articleId,
                          weightDelta,
                          reason,
                          document,
                        ) => {
                          if (
                            await createCorrection({
                              cardId: selected.id,
                              articleId,
                              weightDelta,
                              reason,
                              document,
                            })
                          ) {
                            setMessage(
                              'Rättelseutkast skapat. Originalet är oförändrat tills rättelsen godkänns.',
                            );
                            navigate('/corrections');
                          }
                        }}
                      />
                    )}
                </div>
              </div>
            </>
          ) : section === 'dashboard' ? (
            <>
              <div className="office-title">
                <div>
                  <span className="office-eyebrow">
                    GOD ÖVERBLICK, FRÅN GÅRD TILL KONTOR
                  </span>
                  <h1>Kontorsöversikt</h1>
                  <p>
                    Här ser du vad som behöver granskas, attesteras och betalas
                    ut.
                  </p>
                </div>
                <span className="office-date">Norrtälje · Kontorsdemo</span>
              </div>
              <div className="office-metrics">
                {(['new', 'complement', 'attest', 'ready'] as const).map(
                  (s, i) => (
                    <button
                      key={s}
                      onClick={() =>
                        navigate(
                          s === 'attest' && can(user, 'attest')
                            ? '/attest'
                            : s === 'ready' && can(user, 'pay')
                              ? '/payments'
                              : `/weighings?${['attest', 'ready'].includes(s) ? 'tab=history&' : ''}status=${s}`,
                        )
                      }
                    >
                      <span className={`office-metric-icon metric-${i}`}>
                        <Scale size={21} />
                      </span>
                      <span>
                        <small>{statusNames[s]}</small>
                        <strong>
                          {data.cards.filter((c) => c.status === s).length}
                        </strong>
                        <em>
                          Visa kön <ChevronRight size={12} />
                        </em>
                      </span>
                    </button>
                  ),
                )}
              </div>
              <div className="office-dashboard-grid">
                <div>
                  <section className="office-panel">
                    <div className="office-panel-heading">
                      <div>
                        <h2>Invägningar från gårdsplan</h2>
                        <p>Senaste viktkorten och deras nästa steg</p>
                      </div>
                      <button
                        className="office-link"
                        onClick={() => navigate('/weighings')}
                      >
                        Visa alla <ChevronRight size={15} />
                      </button>
                    </div>
                    <CardTable
                      customers={data.customers}
                      cards={data.cards
                        .filter((c) => c.status !== 'paid')
                        .sort((a, b) => b.id - a.id)}
                      showMoney={can(user, 'prices') || can(user, 'reports')}
                      user={user}
                      open={open}
                      selectedId={previewId}
                      onSelect={setPreviewId}
                    />
                  </section>
                  {data.cards.find((c) => c.id === previewId) && (
                    <CardPreview
                      customers={data.customers}
                      card={data.cards.find((c) => c.id === previewId)!}
                      user={user}
                      onOpen={open}
                    />
                  )}
                </div>
                <aside>
                  <QuickActions user={user} onNavigate={navigate} />
                  <DailyWeights cards={data.cards} />
                  <section className="office-panel">
                    <h2>Senaste aktivitet</h2>
                    <ol className="office-audit">
                      {data.cards
                        .flatMap((c) =>
                          c.audit.map((a) => ({ ...a, cardId: c.id })),
                        )
                        .filter(
                          (a) =>
                            !a.text.startsWith('Pris för') ||
                            (can(user, 'changePrice') &&
                              can(user, 'customerPrices')),
                        )
                        .sort((a, b) => b.at.localeCompare(a.at))
                        .slice(0, 5)
                        .map((a, i) => (
                          <li key={i}>
                            <i />
                            <div>
                              <button
                                className="office-link"
                                onClick={() => open(a.cardId)}
                              >
                                Vägning #{a.cardId}
                              </button>
                              <small>
                                {safeAuditText(user, a.text)}
                                <br />
                                {a.actor}
                              </small>
                            </div>
                          </li>
                        ))}
                    </ol>
                  </section>
                </aside>
              </div>
            </>
          ) : ['weighings', 'attest', 'payments'].includes(section) ? (
            <>
              <div className="office-title">
                <div>
                  <h1>
                    {section === 'attest'
                      ? 'Attestöversikt'
                      : section === 'payments'
                        ? 'Utbetalningar'
                        : 'Invägningar'}
                  </h1>
                  <p>
                    {section === 'attest'
                      ? `Din attestgräns: ${money(user.maxAttest)} kr. Kort över gränsen visas men kan inte godkännas.`
                      : section === 'payments'
                        ? 'Attesterade kort som är klara för utbetalning i demon.'
                        : historyTab
                          ? 'Sök alla viktkort och följ var de finns i arbetsflödet.'
                          : 'Nya kort och underlag som behöver kompletteras.'}
                  </p>
                </div>
                {can(user, 'reports') && (
                  <button
                    className="office-btn outline"
                    onClick={() => exportOfficeCsv(cards, user)}
                  >
                    <Download size={16} />
                    Exportera kö
                  </button>
                )}
              </div>
              {(section === 'attest' || section === 'payments') && (
                <QueueSummary cards={data.cards} user={user} mode={section} />
              )}
              <div className="office-queue-controls">
                <div
                  role="tablist"
                  aria-label="Vägningskö"
                  className="office-filters"
                >
                  {['Aktiva', 'Historik'].map((label, i) => (
                    <button
                      key={label}
                      role="tab"
                      aria-selected={historyTab === Boolean(i)}
                      className={historyTab === Boolean(i) ? 'active' : ''}
                      onClick={() => {
                        setPreviewId(undefined);
                        navigate(`/${section}${i ? '?tab=history' : ''}`);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="office-queue-search">
                  <label className="office-search">
                    <Search size={17} />
                    <input
                      aria-label="Sök i kön"
                      placeholder="Sök viktkort, kund, registrering eller referens…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <select
                    aria-label="Filtrera status"
                    value={filter ?? ''}
                    onChange={(e) => {
                      const q = new URLSearchParams(location.search);
                      e.target.value
                        ? q.set('status', e.target.value)
                        : q.delete('status');
                      navigate(`/${section}?${q}`);
                    }}
                  >
                    <option value="">Alla statusar</option>
                    {Object.entries(statusNames)
                      .filter(([status]) =>
                        data.cards.some(
                          (c) =>
                            c.status === status &&
                            inQueue(c, section, historyTab),
                        ),
                      )
                      .map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <section className="office-panel">
                <CardTable
                  customers={data.customers}
                  cards={cards}
                  showMoney={can(user, 'prices') || can(user, 'reports')}
                  user={user}
                  open={open}
                  selectedId={previewId}
                  onSelect={setPreviewId}
                />
                {!cards.length && (
                  <p>Inga vägningar matchar den här kön eller sökningen.</p>
                )}
              </section>
              {cards.find((c) => c.id === previewId) && (
                <CardPreview
                  customers={data.customers}
                  card={cards.find((c) => c.id === previewId)!}
                  user={user}
                  onOpen={open}
                />
              )}
            </>
          ) : section === 'customers' ? (
            <CustomerWorkspace
              data={data}
              user={user}
              actualUser={actualUser!}
              onSaveCustomer={saveCustomer}
              onOpenCard={open}
              onNotice={setMessage}
              onCreateCorrection={createCorrection}
              onSubmitCorrection={sendCorrection}
              onApproveCorrection={approveCorrectionCard}
            />
          ) : ['prices', 'lme'].includes(section) ? (
            <PricingWorkspace
              user={user}
              actualUser={actualUser!}
              onNotice={setMessage}
              section={
                section === 'lme'
                  ? 'lme'
                  : new URLSearchParams(location.search).get('tab') ===
                      'customer-prices'
                    ? 'customer-prices'
                    : 'articles'
              }
              onSectionChange={(next) =>
                navigate(
                  next === 'lme'
                    ? '/lme'
                    : next === 'customer-prices'
                      ? '/prices?tab=customer-prices'
                      : '/prices',
                )
              }
            />
          ) : section === 'corrections' ? (
            <CorrectionsWorkspace
              data={data}
              user={user}
              onOpenCard={open}
              onSubmit={sendCorrection}
              onSaveDocument={saveCorrectionDocument}
              onApprove={approveCorrectionCard}
              busy={priceBusy}
            />
          ) : section === 'users' ? (
            <UserAdmin
              users={data.users}
              actor={user}
              save={async (users) => {
                if (!can(user, 'users')) return false;
                try {
                  await pricingRequest('users', user, actualUser!, { users });
                  return persist({ ...data, users });
                } catch (e) {
                  setMessage(
                    e instanceof Error
                      ? e.message
                      : 'Behörigheterna kunde inte sparas på servern.',
                  );
                  return false;
                }
              }}
            />
          ) : (
            <section className="office-panel">
              <h1>Vyn finns inte</h1>
              <button
                className="office-btn"
                onClick={() => navigate('/dashboard')}
              >
                Till översikten
              </button>
            </section>
          )}
          {documentType && selected && cardMoneyVisible(user, selected) && (
            <OfficeDocument
              card={selected}
              customer={selectedCustomer}
              payment={data.payments.find((p) => p.cardId === selected.id)}
              showRowPrice={(row) => rowVisible(user, row)}
              showPaymentDetails={
                can(user, 'paymentDetails') ||
                can(user, 'pay') ||
                can(user, 'attest')
              }
              type={documentType}
              onClose={() => setDocumentType(undefined)}
            />
          )}
          <footer className="office-footer">
            JEROC Kontorsdemo {OFFICE_VERSION} · Lokal testdata ·{' '}
            <button
              className="office-link"
              onClick={() => {
                if (
                  window.confirm(
                    'Återställ bara kontorsdemons testdata? Gårdsappens data påverkas inte.',
                  ) &&
                  persist(seedOffice(), true)
                ) {
                  sessionStorage.removeItem('jeroc.office.user');
                  sessionStorage.removeItem('jeroc.office.acting');
                  setActingId('');
                  setUserId(undefined);
                  navigate('/dashboard');
                }
              }}
            >
              Återställ kontorsdemo
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Status({ status }: { status: OfficeCard['status'] }) {
  return (
    <span className={`office-status status-${status}`}>
      {status === 'ready' || status === 'paid' ? <Check size={13} /> : null}
      {statusNames[status]}
    </span>
  );
}
function MaterialImage({ id }: { id: string }) {
  const a = articleById(id),
    cell = a.photos[0];
  return (
    <span
      className="office-material-image"
      role="img"
      aria-label={a.name}
      style={{
        backgroundImage: `url(${cell >= 28 ? '/images/copper-grades.png' : '/images/materials.png'})`,
        backgroundSize: cell >= 28 ? '400% 300%' : '400% 700%',
        backgroundPosition: `${(((cell >= 28 ? cell - 28 : cell) % 4) * 100) / 3}% ${(Math.floor((cell >= 28 ? cell - 28 : cell) / 4) * 100) / (cell >= 28 ? 2 : 6)}%`,
      }}
    />
  );
}
function CardTable({
  cards,
  customers,
  showMoney,
  user,
  open,
  selectedId,
  onSelect,
}: {
  cards: OfficeCard[];
  customers?: OfficeCustomer[];
  showMoney: boolean;
  user: OfficeUser;
  open: (id: number) => void;
  selectedId?: number;
  onSelect?: (id: number) => void;
}) {
  return (
    <div className="office-table-wrap">
      <table className="office-table">
        <thead>
          <tr>
            <th>Viktkort</th>
            <th>Kund / invägare</th>
            <th>Vikt</th>
            {showMoney && <th>Belopp</th>}
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr
              key={c.id}
              className={selectedId === c.id ? 'office-row-selected' : ''}
              onClick={() => onSelect?.(c.id)}
            >
              <td>
                <button
                  className="office-link"
                  aria-label={`Förhandsvisa viktkort ${c.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect?.(c.id);
                  }}
                >
                  #{c.id}
                </button>
                <small>{fmt(c.date)}</small>
              </td>
              <td>
                <strong>
                  {c.customerSnapshot?.name ??
                    customers?.find((x) => x.id === c.customerId)?.name ??
                    customerName(c)}
                </strong>
                <small>
                  {c.weigher} · {c.yard}
                </small>
              </td>
              <td>
                {kilos(weight(c))} kg<small>{c.rows.length} material</small>
              </td>
              {showMoney && (
                <td>
                  {cardMoneyVisible(user, c) ? `${money(amount(c))} kr` : '–'}
                </td>
              )}
              <td>
                <Status status={c.status} />
              </td>
              <td>
                <button
                  className="office-view"
                  aria-label={`Öppna viktkort ${c.id}`}
                  onClick={() => open(c.id)}
                >
                  Visa <ChevronRight size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function PriceEditor({
  row,
  disabled,
  user,
  rates,
  onSave,
}: {
  disabled: boolean;
  user: OfficeUser;
  rates?: Record<'A' | 'B' | 'C', number | null>;
  row: OfficeCard['rows'][number];
  onSave: (tier: OfficeCard['rows'][number]['tier'], price: number) => boolean;
}) {
  const [open, setOpen] = useState(false),
    [tier, setTier] = useState(row.tier),
    [price, setPrice] = useState(String(row.price));
  return open ? (
    <form
      className="office-price-edit"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(price.replace(',', '.'));
        if (price.trim() && Number.isFinite(n) && n >= 0 && onSave(tier, n))
          setOpen(false);
      }}
    >
      <select
        aria-label="Prisalternativ"
        value={tier}
        onChange={(e) => {
          const t = e.target.value as typeof tier;
          setTier(t);
          if (t !== 'Eget')
            setPrice(String(rates?.[t as 'A' | 'B' | 'C'] ?? row.price));
        }}
      >
        {['A', 'B', 'C', 'Eget']
          .filter((t) => t === 'Eget' || can(user, `price${t}` as Permission))
          .map((t) => (
            <option
              key={t}
              disabled={t !== 'Eget' && rates?.[t as 'A' | 'B' | 'C'] == null}
            >
              {t}
            </option>
          ))}
      </select>
      <input
        aria-label="Engångspris kr/kg"
        readOnly={tier !== 'Eget'}
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        inputMode="decimal"
      />
      <button className="office-view">Spara pris</button>
      <button
        type="button"
        className="office-link"
        onClick={() => setOpen(false)}
      >
        Avbryt
      </button>
    </form>
  ) : (
    <button
      className="office-link"
      disabled={disabled}
      onClick={() => {
        setTier(row.tier);
        setPrice(String(row.price));
        setOpen(true);
      }}
    >
      Ändra pris
    </button>
  );
}
function DetailFields({
  card,
  customer,
  disabled,
  save,
}: {
  card: OfficeCard;
  disabled: boolean;
  customer?: OfficeCustomer;
  save: (r: string, o: string) => boolean;
}) {
  const [reference, setReference] = useState(card.reference),
    [origin, setOrigin] = useState(card.origin);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(reference, origin);
      }}
    >
      <label>
        Referens
        <input
          disabled={disabled || !card.customerId}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          list="office-reference"
        />
      </label>
      <datalist id="office-reference">
        {customer?.references.map((r) => (
          <option value={r} key={r} />
        ))}
      </datalist>
      <label>
        Ursprungsadress
        <input
          disabled={disabled || !card.customerId}
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          list="office-origin"
        />
      </label>
      <datalist id="office-origin">
        {customer?.origins.map((r) => (
          <option value={r} key={r} />
        ))}
      </datalist>
      {!disabled && (
        <button className="office-btn outline" disabled={!card.customerId}>
          Spara referens & ursprung
        </button>
      )}
    </form>
  );
}
function CorrectionForm({
  card,
  onSave,
}: {
  card: OfficeCard;
  onSave: (
    a: string,
    w: number,
    r: string,
    document?: string,
  ) => void | Promise<void>;
}) {
  const [article, setArticle] = useState(card.rows[0].articleId),
    [delta, setDelta] = useState(''),
    [reason, setReason] = useState(''),
    [document, setDocument] = useState('');
  return (
    <section className="office-panel">
      <h2>Skapa rättelseutkast</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(delta.replace(',', '.'));
          if (delta.trim() && Number.isFinite(n) && n !== 0 && reason.trim())
            onSave(article, n, reason.trim(), document.trim());
        }}
      >
        <label>
          Material
          <select value={article} onChange={(e) => setArticle(e.target.value)}>
            {card.rows.map((r) => (
              <option key={r.articleId} value={r.articleId}>
                {articleById(r.articleId).name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Viktändring, kg
          <input
            required
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            placeholder="Exempel: −100 eller +25"
          />
        </label>
        <label>
          Orsak / rättelseunderlag
          <input
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label>
          Rättelseunderlag
          <input
            value={document}
            onChange={(e) => setDocument(e.target.value)}
            placeholder="Exempel RU-003"
          />
        </label>
        <button className="office-btn outline">Skapa rättelseutkast</button>
      </form>
    </section>
  );
}
function UserAdmin({
  users,
  actor,
  save,
}: {
  users: OfficeUser[];
  actor: OfficeUser;
  save: (u: OfficeUser[]) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState(users[0]),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false);
  const editable =
    actor.level === 'Systemadmin' || selected.level !== 'Systemadmin';
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      !editable ||
      selected.maxAttest < 0 ||
      (actor.level !== 'Systemadmin' && selected.maxAttest > actor.maxAttest) ||
      !Number.isFinite(selected.maxAttest)
    )
      return;
    setSaving(true);
    if (
      await save(
        users.some((u) => u.id === selected.id)
          ? users.map((u) => (u.id === selected.id ? selected : u))
          : [...users, selected],
      )
    )
      setNotice(
        'Behörigheterna har sparats i kontorsdemon och på prismotorns demoserver.',
      );
    setSaving(false);
  }
  return (
    <>
      <div className="office-title">
        <div>
          <h1>Användare & behörigheter</h1>
          <p>
            Kontonivå och valbara moment. Reglerna gäller bara i den här demon.
          </p>
        </div>
        <button
          className="office-btn"
          onClick={() => {
            setNotice('');
            setSelected({
              id: crypto.randomUUID(),
              name: '',
              level: 'Medarbetare',
              permissions: ['view'],
              maxAttest: 0,
              ownAttest: false,
            });
          }}
        >
          <Plus size={17} />
          Ny användare
        </button>
      </div>
      <div className="office-user-admin">
        <section className="office-panel">
          {users.map((u) => (
            <button
              className={`office-user-choice ${u.id === selected.id ? 'active' : ''}`}
              key={u.id}
              onClick={() => {
                setSelected(u);
                setNotice('');
              }}
            >
              <strong>{u.name}</strong>
              <small>{u.level}</small>
            </button>
          ))}
        </section>
        <section className="office-panel">
          <form onSubmit={submit}>
            <h2>{selected.name || 'Ny användare'}</h2>
            {notice && <p role="status">{notice}</p>}
            {!editable && (
              <div className="office-alert">
                VD kan inte ändra ett systemadminkonto.
              </div>
            )}
            <label>
              Namn
              <input
                required
                value={selected.name}
                disabled={!editable}
                onChange={(e) =>
                  setSelected({ ...selected, name: e.target.value })
                }
              />
            </label>
            <label>
              Kontonivå
              <select
                disabled={!editable || selected.id === actor.id}
                value={selected.level}
                onChange={(e) =>
                  setSelected({
                    ...selected,
                    level: e.target.value as OfficeUser['level'],
                  })
                }
              >
                {[
                  'Medarbetare',
                  'VD',
                  ...(actor.level === 'Systemadmin' ? ['Systemadmin'] : []),
                ].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <div className="office-permission-grid">
              {Object.entries(permissionNames).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    disabled={!editable || selected.level !== 'Medarbetare'}
                    checked={can(selected, key as Permission)}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        permissions: e.target.checked
                          ? [
                              ...new Set([
                                ...selected.permissions,
                                key as Permission,
                                ...(key === 'lmeWrite'
                                  ? ['lmeRead' as const]
                                  : []),
                              ]),
                            ]
                          : selected.permissions.filter(
                              (p) =>
                                p !== key &&
                                !(key === 'lmeRead' && p === 'lmeWrite'),
                            ),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <label>
              Maxbelopp för attest (kr)
              <input
                type="number"
                min="0"
                max={
                  actor.level === 'Systemadmin' ? undefined : actor.maxAttest
                }
                step="0.01"
                value={selected.maxAttest}
                disabled={!editable}
                onChange={(e) =>
                  setSelected({
                    ...selected,
                    maxAttest: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="office-checkbox">
              <input
                type="checkbox"
                checked={selected.ownAttest}
                disabled={!editable}
                onChange={(e) =>
                  setSelected({ ...selected, ownAttest: e.target.checked })
                }
              />
              Får attestera egna förberedda kort
            </label>
            <button className="office-btn" disabled={!editable || saving}>
              Spara behörigheter
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
