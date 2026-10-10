import { lazy, Suspense, useEffect, useRef, useState } from 'react';
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
  Truck,
  Monitor,
  ClipboardCheck,
  ChevronDown,
  Calculator,
  Leaf,
  Battery,
  Building2,
} from 'lucide-react';
import { initialCustomers, articleById } from '../data';
import OfficeDocument from './OfficeDocument';
import CustomerWorkspace from './CustomerWorkspace';
import PaymentEditor from './PaymentEditor';
import CorrectionsWorkspace from './CorrectionsWorkspace';
import TerminalWorkspace, { TerminalSelectors } from './TerminalWorkspace';
import CustomerApprovalsWorkspace, { ApprovalVersionPreview } from './CustomerApprovalsWorkspace';
import ApprovalControls from './ApprovalControls';
import OfficeCardAttest from './OfficeCardAttest';
import QuickCustomerModal from './QuickCustomerModal';
import AddWeighingArticleModal from './AddWeighingArticleModal';
import StaffAccountPanel from './personnel/StaffAccountPanel';
import { EnvironmentSessionProvider } from './EnvironmentSession';
import EnvironmentReceiptPanel from './EnvironmentReceiptPanel';
import EnvironmentWorkspace from './EnvironmentWorkspace';
import { useTerminalDemo } from './useTerminalDemo';
import { terminalDemoApi } from './terminal-demo-client';
import type { TerminalApproval } from './terminal-demo-types';
const TransportWorkspace = lazy(() => import('./transport/TransportWorkspace'));
const FacilitiesWorkspace = lazy(() => import('./FacilitiesWorkspace'));
const PersonalWorkspace = lazy(() => import('./personnel/PersonalWorkspace'));
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
import { useSharedData } from '../shared-data';
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
const approvalMoneyVisible = (u: OfficeUser) =>
  ['reports', 'attest', 'pay'].some(right => can(u, right as Permission)) ||
  ['prices', 'priceA', 'priceB', 'priceC', 'customerPrices'].every(right => can(u, right as Permission));
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
  const [previewId, setPreviewId] = useState<number | undefined>(2050);
  const [pricing, setPricing] = useState<PricingState>();
  const [priceBusy, setPriceBusy] = useState(false);
  const [addArticleCardId, setAddArticleCardId] = useState<number>();
  const [pricingError, setPricingError] = useState('');
  const [search, setSearch] = useState('');
  const [detailsDirty, setDetailsDirty] = useState(false);
  const [environmentGuidance, setEnvironmentGuidance] = useState<{ cardId: number; sourceId?: string; loaded: boolean; visible: boolean; received: boolean; canConfirm: boolean }>();
  const [message, setMessage] = useState('');
  const location = useLocation(),
    navigate = useNavigate();
  const actualUser = data.users.find((u) => u.id === userId && u.active !== false);
  const user =
    actualUser?.level === 'Systemadmin' && actingId
      ? (data.users.find((u) => u.id === actingId && u.active !== false) ?? actualUser)
      : actualUser;
  const principalRef = useRef('');
  principalRef.current = `${actualUser?.id ?? ''}:${user?.id ?? ''}`;
  const acting = Boolean(actualUser && user && actualUser.id !== user.id);

  const terminalDemo = useTerminalDemo(actualUser, user);
  const [siteFilter, setSiteFilter] = useState('all');
  const [selectedTerminalId, setSelectedTerminalId] = useState('');
  useEffect(() => { setSelectedTerminalId(''); }, [user?.id, siteFilter]);
  useEffect(() => {
    if (!terminalDemo.state || !user) return;
    // Approval status, frozen prices, audit and payment history are projected
    // together by the office API. A terminal response (possibly redacted for
    // this user) must never become a new business-data write for every card.
    void shared.refresh();
  }, [terminalDemo.state?.revision, user?.id, actualUser?.id]);
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
  const selectedApproval = selected?.customerApproval
    ? terminalDemo.state?.approvals.find(item => item.id === selected.customerApproval?.id)
    : undefined;
  const customerApprovalValid = Boolean(selectedApproval && selected?.customerApproval &&
    selectedApproval.version === selected.customerApproval.version &&
    ['approved', 'attested'].includes(selectedApproval.status));
  const matchingEnvironmentalState = selected && environmentGuidance?.cardId === selected.id && environmentGuidance.sourceId === selected.sourceId
    ? environmentGuidance : undefined;
  const receiptStatus = selected?.kind === 'correction' ? 'not-required' as const
    : user && can(user, 'environmentRead')
      ? !matchingEnvironmentalState?.loaded ? 'checking' as const
        : !matchingEnvironmentalState.visible ? 'not-required' as const
          : matchingEnvironmentalState.received ? 'confirmed' as const : 'required' as const
      : undefined;
  const approvalDisabledReason = !selected ? ''
    : !selected.customerId ? 'Välj eller skapa en kund innan kundgodkännandet startas.'
    : !selected.origin.trim() ? 'Fyll i och spara ursprungsadressen innan kundgodkännandet startas.'
    : detailsDirty ? 'Spara referens och ursprungsadress innan kundgodkännandet startas.'
    : !(validPaymentDetails(selected.paymentDetails) || selected.payment.trim()) ? 'Fyll i och spara betalningsuppgifterna innan kundgodkännandet startas.'
    : !user || !can(user, 'prepare') || !can(user, 'customerApprovalRead') ? 'Du saknar behörighet att starta kundgodkännande.'
    : !approvalMoneyVisible(user) ? 'Ekonomibehörighet eller tillgång till samtliga prislistor och kundpriser krävs för kundvisning.'
    : priceBusy ? 'Prisunderlaget beräknas. Vänta innan kundgodkännandet startas.'
    : blocked ? 'Uppgifterna kan inte sparas. Åtgärda lagringsfelet innan kundgodkännandet startas.'
    : '';
  const cardSiteId = (card: OfficeCard) => card.siteId ?? (/rimbo/i.test(card.yard) ? 'rimbo' : 'norrtalje');
  const selectedSiteId = selected ? cardSiteId(selected) : siteFilter === 'all' ? 'norrtalje' : siteFilter;
  const preferredTerminalId = selectedTerminalId || terminalDemo.state?.defaults.find(item => item.userId === user?.id && item.siteId === selectedSiteId)?.terminalId ||
    (terminalDemo.state?.terminals.filter(item => item.active && item.siteId === selectedSiteId).length === 1
      ? terminalDemo.state.terminals.find(item => item.active && item.siteId === selectedSiteId)?.id : '') || '';
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
  const [attestBusy, setAttestBusy] = useState(false);
  const [quickCustomerOpen, setQuickCustomerOpen] = useState(false);
  const [customerCreation, setCustomerCreation] = useState<{ cardId: number; returnRoute: string; draft: OfficeCustomer; principal: string }>();
  const [approvalPreview, setApprovalPreview] = useState<TerminalApproval>();
  useEffect(() => {
    setPayBalance(false);
    setDocumentType(undefined);
    setQuickCustomerOpen(false);
    setAddArticleCardId(undefined);
    setApprovalPreview(undefined);
    setDetailsDirty(false);
  }, [selectedId, userId, actingId]);
  useEffect(() => { setCustomerCreation(undefined); }, [userId, actingId]);
  useEffect(() => {
    if (location.pathname !== '/customers/new') setCustomerCreation(undefined);
  }, [location.pathname]);
  useEffect(() => {
    let current = true;
    setPricing(undefined);
    if (user && actualUser && (can(user, 'prices') || can(user, 'lmeRead') || can(user, 'weighingAddArticle')))
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
  const shared = useSharedData<OfficeData>({domain:'office',key:officeKey,identity:actualUser&&user?{actor:actualUser.id,user:user.id}:undefined,current:dataRef,accept:next=>{setData(next);setBlocked(false);},error:setError,parse:value=>officeSchema.parse(value)});
  function persist(next: OfficeData, force = false) {
    if (blocked && !force) return false;
    try { return shared.save(officeSchema.parse(next)); }
    catch { setError('Kontrollera de ändrade uppgifterna.'); return false; }
  }
  function login(id: string) {
    try {
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
    if (card.status === 'attest' && old.customerApproval &&
      !['approved', 'attested'].includes(old.customerApproval.status)) {
      setMessage('Kunden måste godkänna den aktuella avräkningen före attest.');
      return false;
    }
    if (old.status === 'customer' && right !== 'verifyId') {
      setMessage('Avsluta kundvisningen innan underlaget ändras.');
      return false;
    }
    if (old.customerApproval?.status === 'approved' && right !== 'attest') {
      setMessage('Återkalla kundgodkännandet innan avräkningen ändras. Kunden behöver sedan godkänna en ny version.');
      return false;
    }
    if (
      old.status !== 'attest' &&
      card.status === 'attest' &&
      (!card.origin.trim() || !old.origin.trim())
    ) {
      setMessage(
        'Fyll i och spara ursprungsadressen innan vägningen skickas för attest.',
      );
      return false;
    }
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
  async function addWeighingArticle(articleId: string, kilograms: number) {
    const current = dataRef.current.cards.find(card => card.id === addArticleCardId);
    if (!user || !actualUser || blocked || priceBusy || !can(user, 'weighingAddArticle') || !current ||
      !['new', 'complement'].includes(current.status) || current.kind === 'correction' ||
      !pricing?.articles.some(article => article.id === articleId && article.active) || !Number.isFinite(kilograms) || kilograms <= 0 || kilograms > 1e9 ||
      Math.abs(kilograms * 1000 - Math.round(kilograms * 1000)) > 0.0001) return false;
    const principal = principalRef.current;
    const rows: OfficeCard['rows'] = [...current.rows, { articleId, articleName: pricing.articles.find(article => article.id === articleId)!.name, weight: kilograms, tier: 'C', price: 0, pricePending: true }];
    setPriceBusy(true);
    try {
      // Hidden prices remain pending; adding weight never grants price visibility.
      let quote: PricingQuote | undefined;
      if (can(user, 'prepare') || can(user, 'prices')) {
        try {
          quote = await pricingRequest<PricingQuote>('quote', user, actualUser, {
            customerId: current.customerId, deliveredAt: current.date, excludeCardId: String(current.id),
            rows: rows.map(row => ({ articleId: row.articleId, weight: row.weight })),
          });
        } catch { /* Keep the row as unpriced until an authorized colleague recalculates. */ }
      }
      const live = dataRef.current.cards.find(card => card.id === current.id);
      if (principalRef.current !== principal || !live || live.audit.length !== current.audit.length ||
        !['new', 'complement'].includes(live.status)) return false;
      const pricedRows = rows.map((row, index) => {
        const result = quote?.rows[index];
        if (!result) return row;
        return { ...row, price: row.manualOverride ? row.price : result.price ?? row.price, pricePending: row.manualOverride ? false : result.price == null,
          tier: row.manualOverride ? row.tier : result.tier === 'Special' ? 'Eget' as const : result.tier,
          volumeBefore: result.volumeBefore ?? undefined, volumeWithDelivery: result.volumeWithDelivery ?? undefined, source: row.manualOverride ? row.source : result.source };
      });
      const pending = pricedRows.some(row => row.pricePending);
      const saved = update({ ...live, rows: pricedRows, pricingSnapshotId: undefined, pricingTotal: pending ? undefined : Math.round(pricedRows.reduce((sum, row) => sum + row.weight * row.price, 0) * 100) / 100,
        pricedAt: quote ? current.date : undefined, financialPending: pending, pricingRowsPending: pending },
        `Artikel tillagd: ${pricing.articles.find(article => article.id === articleId)?.name}, ${kilos(kilograms)} kg.`, 'weighingAddArticle');
      if (saved) { setAddArticleCardId(undefined); setMessage(pending ? 'Artikeln tillagd. Beräkna priser innan kundgodkännande.' : 'Artikeln tillagd och priserna uppdaterade.'); }
      return saved;
    } finally { setPriceBusy(false); }
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
      return update(
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
  async function prepareCard(card: OfficeCard, terminal: { id: string; siteId: string }) {
    if (
      !user ||
      !actualUser ||
      !can(user, 'prepare') ||
      !can(user, 'customerApprovalRead') ||
      priceBusy ||
      blocked ||
      !['new', 'complement'].includes(card.status) ||
      !card.customerId ||
      !(
        validPaymentDetails(card.paymentDetails) || Boolean(card.payment.trim())
      )
    )
      return false;
    if (!card.origin.trim() || detailsDirty || !dataRef.current.cards.find(item => item.id === card.id)?.origin.trim()) {
      setMessage(
        'Fyll i och spara ursprungsadressen innan kundgodkännandet startas.',
      );
      return false;
    }
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
            ...(can(user, 'changePrice') && !r.pricePending && (r.manualOverride || !r.source)
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
      if (principalRef.current !== principalId) return false;
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
      const customer = dataRef.current.customers.find(item => item.id === card.customerId) ?? card.customerSnapshot;
      if (!customer || snapshot.total == null || rows.some(row => row.pricePending)) throw new Error('Kund och fullständiga priser krävs för kundvisningen.');
      const frozen: OfficeCard = {
        ...card, rows, siteId: terminal.siteId, pricingSnapshotId: snapshot.id,
        pricedAt: card.date, pricingTotal: snapshot.total, financialPending: false, pricingRowsPending: false,
        preparedBy: user.id, customerSnapshot: customer,
        paymentDetails: card.paymentDetails ?? customer.paymentProfile,
      };
      const preview = settlementPreview({ ...dataRef.current, cards: dataRef.current.cards.map(item => item.id === card.id ? { ...frozen, status: 'ready' as const } : item) }, card.id);
      const sentReview = await terminalDemoApi.send({
        card: frozen, customer, terminalId: terminal.id, siteId: terminal.siteId,
        rows: rows.map(row => ({ articleId: row.articleId, name: row.articleName ?? articleById(row.articleId)?.name ?? row.articleId, weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })),
        offset: preview.offset, correctionIds: preview.negativeCorrectionIds,
        idempotencyKey: `review-${snapshot.id}-${terminal.id}-${card.customerApproval?.version ?? 0}`,
      });
      if (!['waiting', 'id_requested'].includes(sentReview.status)) throw new Error('Kundvisningen kunde inte startas. Läs in kortet och försök igen.');
      await terminalDemo.refresh();
      setMessage('Avräkningen visas på kundterminalen. Inväntar kundens svar.');
      return true;
    } catch (e) {
      const failure = e instanceof Error ? e : new Error('Underlaget kunde inte låsas. Försök igen.');
      setMessage(failure.message);
      throw failure;
    } finally {
      setPriceBusy(false);
    }
  }
  async function attestCard(card: OfficeCard) {
    if (!user || !actualUser || attestBusy || priceBusy || blocked || !can(user, 'attest')) return;
    const current = dataRef.current.cards.find(item => item.id === card.id);
    if (!current || current.status !== 'attest') return;
    const principal = principalRef.current;
    setAttestBusy(true);
    try {
      if (current.customerApproval) {
        await terminalDemoApi.attest(current.customerApproval.id);
        if (principalRef.current !== principal) return;
        await terminalDemo.refresh();
        await shared.refresh();
      } else if (!update({ ...current, status: current.paymentDetails?.method === 'balance' ? 'balance' : 'ready', approvedBy: user.id },
        current.paymentDetails?.method === 'balance' ? 'Kortet attesterat. Beloppet sparat på kundens saldo.' : 'Kortet attesterat och klart för utbetalning.', 'attest')) return;
      setMessage(current.paymentDetails?.method === 'balance' ? 'JEROC-attesterat. Beloppet ligger på kundens saldo.' : 'Kortet är JEROC-attesterat och klart för manuell utbetalning.');
      // Keep the current card and its menu context; the shared queues update independently.
    } catch (failure) {
      if (principalRef.current === principal) setMessage(failure instanceof Error ? failure.message : 'Kortet kunde inte attesteras.');
    } finally { setAttestBusy(false); }
  }
  async function returnCard(card: OfficeCard) {
    if (!user || blocked || attestBusy || priceBusy || !can(user, 'attest')) return;
    if (card.customerApproval) {
      if (!can(user, 'prepare')) return;
      try {
        await terminalDemoApi.cancel(card.customerApproval.id);
        await terminalDemo.refresh();
        setMessage('Kundgodkännandet har återkallats. Komplettera kortet och visa en ny version för kunden.');
      } catch (failure) { setMessage(failure instanceof Error ? failure.message : 'Kortet kunde inte returneras.'); }
    } else update({ ...card, status: 'complement' }, 'Returnerat för komplettering.', 'attest');
  }
  const editable =
    selected &&
    !['customer', 'attest', 'ready', 'paid', 'balance'].includes(selected.status);
  type FocusPanel = 'customer' | 'payment' | 'approval' | 'environment' | 'attest';
  const nextPanel = (): FocusPanel | undefined => {
    if (!selected || !user || !actualUser || blocked || ['ready', 'paid', 'balance'].includes(selected.status)) return;
    if (editable && (!selected.customerId || !selected.origin.trim() || detailsDirty)) {
      if ((!selected.customerId && can(user, 'customers')) || (selected.customerId && can(user, 'prepare'))) return 'customer';
      return;
    }
    if (editable && !(validPaymentDetails(selected.paymentDetails) || selected.payment.trim())) {
      if (can(user, 'paymentDetails')) return 'payment';
      return;
    }
    if (editable && !approvalDisabledReason) return 'approval';
    if (selectedApproval?.status === 'id_requested' && can(user, 'prepare') && can(user, 'verifyId')) return 'approval';
    if (environmentGuidance?.cardId === selected.id && environmentGuidance.sourceId === selected.sourceId &&
      environmentGuidance.visible && !environmentGuidance.received && environmentGuidance.canConfirm) return 'environment';
    if (selected.status === 'attest' && receiptStatus !== 'required' && receiptStatus !== 'checking' && can(user, 'attest') && !selected.financialPending && amount(selected) <= user.maxAttest &&
      (user.ownAttest || (selected.preparedBy !== user.id && selectedApproval?.actualUserId !== actualUser.id)) &&
      (!selected.customerApproval || selectedApproval?.status === 'approved')) return 'attest';
  };
  const focusPanel = nextPanel();
  const panelGuidance = (panel: FocusPanel): 'focus' | 'muted' | undefined => focusPanel ? focusPanel === panel ? 'focus' : 'muted' : undefined;
  const panelClass = (panel: FocusPanel) => panelGuidance(panel) ? ` office-guidance-${panelGuidance(panel)}` : '';
  const nav = [
    { id: 'dashboard', name: 'Översikt', icon: LayoutDashboard, right: 'view' },
    { id: 'weighings', name: 'Invägningar', icon: Scale, right: 'view' },
    { id: 'customer-approvals', name: 'Kundgodkännande', icon: ClipboardCheck, right: 'customerApprovalRead' },
    { id: 'attest', name: 'Attest', icon: BadgeCheck, right: 'attest' },
    { id: 'payments', name: 'Utbetalningar', icon: Wallet, right: 'pay' },
    { id: 'customers', name: 'Kunder', icon: Users, right: 'view' },
    { id: 'transport', name: 'Transportplanering', icon: Truck, right: 'transportRead' },
    { id: 'personnel', name: 'Personal', icon: Users, right: 'personnelRead' },
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
    { id: 'environment', name: 'Miljörapportering', icon: Leaf, right: 'environmentRead' },
    { id: 'facilities', name: 'Anläggningar', icon: Building2, right: 'environmentRead' },
    {
      id: 'corrections',
      name: 'Rättelser',
      icon: History,
      right: 'corrections',
    },
    { id: 'terminals', name: 'Terminaler', icon: Monitor, right: 'users' },
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
  const visibleCards = data.cards.filter(c => siteFilter === 'all' || cardSiteId(c) === siteFilter);
  const navigationCounts: Record<string, number> = Object.fromEntries(workflowSections.map(section => [section, visibleCards.filter(card => inQueue(card, section, false)).length]));
  navigationCounts.corrections = data.corrections.filter(correction => correction.status !== 'approved' && visibleCards.some(card => card.id === correction.cardId)).length;
  const cards = visibleCards
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
  async function selectCreatedCustomer(customer: OfficeCustomer, cardId: number, principal: string, alreadySaved = false) {
    if (!user || blocked || !can(user, 'customers') || principalRef.current !== principal) return false;
    const card = dataRef.current.cards.find(item => item.id === cardId);
    if (!card || !['new', 'complement'].includes(card.status)) {
      setMessage('Kortet är låst. Kunden kan inte kopplas till det.');
      return false;
    }
    if (!alreadySaved && !await saveCustomer(customer)) return false;
    if (principalRef.current !== principal) return false;
    const current = dataRef.current.cards.find(item => item.id === cardId);
    if (!current || !['new', 'complement'].includes(current.status)) return false;
    const saved = await calculatePrices(current, customer.id, true);
    if (!saved) return false;
    setQuickCustomerOpen(false);
    setMessage('Kunden är skapad och vald på invägningen.');
    return true;
  }
  async function finishCustomerCreation(customer: OfficeCustomer) {
    if (!customerCreation || !await selectCreatedCustomer(customer, customerCreation.cardId, customerCreation.principal, true)) return false;
    navigate(customerCreation.returnRoute);
    setCustomerCreation(undefined);
    return true;
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
      if (card.customerApproval) {
        const review = terminalDemo.state?.approvals.find(item => item.id === card.customerApproval?.id);
        if (!review || review.status !== 'attested') throw new Error('Läs in JEROC:s attest från terminaltjänsten innan demoutbetalningen registreras.');
        if (preview.gross !== review.snapshot.gross || preview.offset !== review.snapshot.offset || preview.net !== review.snapshot.net)
          throw new Error('Saldot har ändrats sedan kundgodkännandet. Ingen demoutbetalning registrerades. Skillnaden behöver hanteras genom rättelse.');
      }
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
      can(user, 'environmentRead') ||
      can(user, 'environmentClassify') ||
      can(user, 'customerPrices') ||
      can(user, 'customerPriceEdit'));
  const terminalAdminDenied = section === 'terminals' && user?.level !== 'Systemadmin';
  const accountsView = section === 'users' ||
    (section === 'personnel' && location.pathname.split('/')[2] === 'accounts') ||
    (section === 'personnel' && user && !can(user, 'personnelRead') && can(user, 'users'));
  async function saveStaffUsers(users: OfficeUser[]) {
    if (!user || !actualUser || !can(user, 'users')) return false;
    try {
      await pricingRequest('users', user, actualUser, { users });
      await shared.refresh();
      return true;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Kontot kunde inte sparas på servern.');
      return false;
    }
  }
  const allowed = accountsView ? 'users' :
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
            Prova arbetsflödet med ett demokonto. Kundterminaler och
            kundgodkännanden delas mellan datorn och mobilen.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="office-demo-users">
            {data.users.filter(u => u.active !== false).map((u) => (
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
            Demokonton med fiktiva uppgifter. Kontoret och mobilen delar vägningar och kunder. Utbetalningar registreras manuellt.
          </p>
          <a href="/">Öppna gårdsappen</a>
        </div>
      </div>
    );
  if (section === 'transport' && can(user, 'transportRead')) {
    return <Suspense fallback={<div role="status">Öppnar transportplaneringen…</div>}><TransportWorkspace
      key={actualUser!.id + ':' + user.id}
      user={user}
      actualUser={actualUser!}
      customers={data.customers}
      officeBlocked={blocked}
      onExit={() => navigate('/dashboard')}
      onOpenStaffing={() => navigate('/personnel/tasks')}
      workAsControl={actualUser?.level === 'Systemadmin' ? (
        <label>Jobba som
          <select aria-label="Jobba som" value={acting ? user.id : ''} onChange={event => workAs(event.target.value)}>
            <option value="">Systemadmin · egen behörighet</option>
            {data.users.filter(candidate => candidate.id !== actualUser.id && candidate.active !== false).map(candidate =>
              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
            )}
          </select>
        </label>
      ) : undefined}
    /></Suspense>;
  }
  return (
    <EnvironmentSessionProvider user={user} actualUser={actualUser!} onNotice={setMessage}>
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
              n.id === 'terminals'
                ? user.level === 'Systemadmin'
                : n.id === 'prices'
                ? pricingAccess
                : n.id === 'corrections'
                  ? can(user, 'corrections') || can(user, 'attest')
                  : n.id === 'personnel'
                    ? can(user, 'personnelRead') || can(user, 'users')
                  : can(user, n.right),
            )
            .map((n) => (
              <button
                className={section === n.id || (section === 'users' && n.id === 'personnel') ? 'active' : ''}
                key={n.id}
                aria-label={n.name}
                aria-describedby={navigationCounts[n.id] > 0 ? `office-nav-count-${n.id}` : undefined}
                onClick={() => {
                  setSearch('');
                  setMessage('');
                  navigate(n.id === 'personnel' && !can(user, 'personnelRead') ? '/personnel/accounts' : `/${n.id}`);
                }}
              >
                <n.icon size={19} />
                {n.name}
                {navigationCounts[n.id] > 0 && (
                  <span id={`office-nav-count-${n.id}`} className="office-nav-count" aria-label={`${navigationCounts[n.id]} aktiva kort`}>
                    {navigationCounts[n.id]}
                  </span>
                )}
              </button>
            ))}
        </nav>
        <div className="office-sidebar-bottom">
          <details className="office-profile-menu office-sidebar-profile">
            <summary className="office-profile-toggle" aria-label="Öppna profilmeny">
              <span className="office-avatar">{user.name.split(' ').map(name => name[0]).join('').slice(0, 2)}</span>
              <span><strong>{user.name}</strong><small>{user.level} · Norrtälje</small></span><ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div className="office-profile-dropdown">
              <strong>{user.name}</strong><p>{user.level} · Kontor Norrtälje</p>
              {actualUser?.level === 'Systemadmin' && <label className="office-work-as">Jobba som
                <select aria-label="Jobba som" value={acting ? user.id : ''} onChange={event => {
                  const menu = event.currentTarget.closest('details');
                  if (menu) menu.open = false;
                  workAs(event.target.value);
                }}>
                  <option value="">Systemadmin · egen behörighet</option>
                  {data.users.filter(person => person.id !== actualUser.id && person.active !== false).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
              </label>}
              {acting && <small>Inloggad som {actualUser!.name}. Åtgärder sparar båda namnen i historiken.</small>}
            </div>
          </details>
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
            {section === 'users' ? 'Personal' : nav.find((n) => n.id === section)?.name ?? 'Vägning'}
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
          <TerminalSelectors state={terminalDemo.state} userId={user.id} siteId={siteFilter}
            onSiteChange={setSiteFilter} terminalId={preferredTerminalId} onTerminalChange={setSelectedTerminalId}
            onRefresh={terminalDemo.refresh} onNotice={setMessage} />

        </header>
        <div className="office-demo-notice">
          Demo · Kundgodkännanden och miljömottagningar delas via servern ·
          Utbetalningar hanteras manuellt · Mobilens färdiga vägningar delas med kontoret
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
        {addArticleCardId === selected?.id && selected && editable && can(user, 'weighingAddArticle') && <AddWeighingArticleModal
          articles={pricing?.articles.filter(article => article.active) ?? []} onSave={addWeighingArticle} onClose={() => setAddArticleCardId(undefined)} />}
        {quickCustomerOpen && selected && can(user, 'customers') && <QuickCustomerModal data={data} user={user}
          onSave={customer => selectCreatedCustomer(customer, selected.id, principalRef.current)}
          onOpenFull={draft => {
            setCustomerCreation({ cardId: selected.id, returnRoute: location.pathname + location.search, draft, principal: principalRef.current });
            setQuickCustomerOpen(false);
      setAddArticleCardId(undefined);
            navigate('/customers/new');
          }} onClose={() => setQuickCustomerOpen(false)} />}
        {approvalPreview && approvalMoneyVisible(user) && <ApprovalVersionPreview approval={approvalPreview}
          siteName={terminalDemo.state?.sites.find(site => site.id === approvalPreview.siteId)?.name ?? approvalPreview.siteId}
          onClose={() => setApprovalPreview(undefined)} />}
        <main className="office-main" aria-busy={!shared.ready}>
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
          {terminalAdminDenied || (allowed && !can(user, allowed)) ? (
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
                  : section === 'customer-approvals'
                    ? 'Till kundgodkännanden'
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
                  <section className="office-panel office-card-material">
                    <div className="office-panel-heading">
                      <h2>Material & prissättning</h2>
                      <strong>{kilos(weight(selected))} kg</strong>
                      {editable && selected.kind !== 'correction' && can(user, 'weighingAddArticle') && <button className="office-link office-add-article" disabled={blocked || priceBusy || !pricing} onClick={() => setAddArticleCardId(selected.id)}>Lägg till artikel</button>}
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
                                  {(r.articleName ?? articleById(r.articleId)?.name ?? r.articleId)}
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
                              {(editable || (selected.status === 'attest' && !selected.customerApproval)) &&
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
                                          `Pris för ${(r.articleName ?? articleById(r.articleId)?.name ?? r.articleId)} ändrat från ${r.tier} ${money(r.price)} till ${tier} ${money(price)} kr/kg.`,
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
                  <section className={`office-panel office-card-customer${panelClass('customer')}`}>
                    <h2>Kund, referens & ursprung</h2>
<div className="office-customer-picker">
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
                    <button className="office-btn" disabled={blocked || priceBusy || !editable || !can(user, 'customers')} onClick={() => setQuickCustomerOpen(true)}><Plus size={16} />Ny kund</button>
                    </div>
                    {!selected.customerId && <div className="office-customer-empty"><Users size={26} /><strong>Ingen kund vald ännu</strong><p>Välj en befintlig kund eller skapa en ny kund direkt härifrån.</p></div>}
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
                      onDirtyChange={setDetailsDirty}
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
                  <section className={`office-panel office-card-payment${panelClass('payment')}`}>
                    <h2>Utbetalning</h2>
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
                  </section>
                  {(can(user, 'customerApprovalRead') || can(user, 'prepare')) && <ApprovalControls
                    guidance={panelGuidance('approval')}
                    approval={selectedApproval}
                    state={terminalDemo.state}
                    siteId={selectedSiteId}
                    terminalId={preferredTerminalId}
                    canSend={Boolean(editable) && !approvalDisabledReason}
                    disabledReason={approvalDisabledReason}
                    onPreview={selectedApproval && approvalMoneyVisible(user) ? () => setApprovalPreview(selectedApproval) : undefined}
                    canConfirmId={can(user, 'prepare') && can(user, 'verifyId')}
                    canCancel={can(user, 'prepare')}
                    canSeeMoney={approvalMoneyVisible(user)}
                    onSend={(terminalId, siteId) => prepareCard(selected, { id: terminalId, siteId })}
                    onRefresh={terminalDemo.refresh}
                    onNotice={setMessage}
                  />}
                  {can(user, 'environmentRead') && selected.kind !== 'correction' && (
                    <EnvironmentReceiptPanel key={selected.sourceId ?? selected.id} card={selected} customer={selectedCustomer}
                      user={user} actualUser={actualUser!} onNotice={setMessage}
                      customerApprovalValid={customerApprovalValid}
                      customerChangeRequested={selectedApproval?.status === 'change_requested'}
                      guidance={panelGuidance('environment')}
                      onGuidanceState={value => setEnvironmentGuidance(previous => previous?.cardId === selected.id && previous.sourceId === selected.sourceId && previous.loaded === value.loaded && previous.visible === value.visible && previous.received === value.received && previous.canConfirm === value.canConfirm ? previous : { cardId: selected.id, sourceId: selected.sourceId, ...value })}
                      canChangeOrigin={Boolean(editable) && can(user, 'prepare')}
                      onOriginChange={(origin) => update({ ...selected, origin }, 'Ursprungsadress uppdaterad från miljökortet.', 'prepare')}
                      onRegistered={(receipt) => {
                        const live = dataRef.current;
                        const card = live.cards.find(item => item.sourceId === receipt.sourceId);
                        const eventId = receipt.correctionHistory?.at(-1)?.id ?? receipt.id;
                        if (!card || card.audit.some(entry => entry.text.includes(eventId))) return;
                        const correction = receipt.correctionHistory?.at(-1);
                        persist({ ...live, cards: live.cards.map(item => item.sourceId !== receipt.sourceId ? item : {
                          ...item, audit: [...item.audit, { at: correction?.createdAt ?? receipt.createdAt,
                            actor: correction?.createdBy ?? receipt.createdBy,
                            text: correction
                              ? `Miljömottagning rättad till version ${receipt.version}: ${correction.reason}. Rättelse ${eventId}; original ${receipt.id}.`
                              : `Faktisk mottagning registrerad i miljölagret. Original ${receipt.id}.` }],
                        }) });
                      }} />
                  )}
                  <OfficeCardAttest card={selected} user={user} actualUser={actualUser!} users={data.users}
                    receiptStatus={receiptStatus}
                    guidance={panelGuidance('attest')} approval={selectedApproval} busy={attestBusy} blocked={blocked || priceBusy}
                    onAttest={() => attestCard(selected)} onReturn={() => returnCard(selected)} />
                  <section className="office-panel office-card-summary">
                    <div className="office-summary-info"><Calculator size={28} aria-hidden="true" /><div><h2>Sammanställning</h2><p>{['ready', 'paid', 'balance'].includes(selected.status) ? 'Attesterat underlag. Utbetalningar registreras manuellt.' : 'Efter kundgodkännande och intern attest blir kortet klart för manuell utbetalning.'}</p></div></div>
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
                        <strong>{money(selectedApproval && ['waiting', 'id_requested', 'approved', 'attested'].includes(selectedApproval.status) ? selectedApproval.snapshot.net : amount(selected))} kr</strong>
                      </div>
                    ) : (
                      <p>
                        {kilos(weight(selected))} kg · {selected.rows.length}{' '}
                        material
                      </p>
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
                    {!['ready', 'paid', 'balance'].includes(selected.status) && (
                      <button
                        className="office-btn outline"
                        disabled={!selectedCustomer || !cardMoneyVisible(user, selected)}
                        onClick={() => setDocumentType('settlement')}
                      >
                        <Printer size={16} /> Förhandsvisa avräkning
                      </button>
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
                  <section className="office-panel office-card-audit">
                    <h2><History size={21} aria-hidden="true" /> Spårbarhet</h2>
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
                      {selected.customerApproval?.approvedAt && <span>
                        Kundgodkännande <strong>{selected.customerApproval.approvedBy}</strong>
                        <small>Fysisk legitimation · version {selected.customerApproval.version} · {fmt(selected.customerApproval.approvedAt)}</small>
                      </span>}
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
                          {visibleCards.filter((c) => c.status === s).length}
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
                      cards={visibleCards
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
                  <DailyWeights cards={visibleCards} />
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
                <QueueSummary cards={visibleCards} user={user} mode={section} />
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
          ) : accountsView ? (
            <>
              <nav className="office-personnel-nav" aria-label="Personal">
                {can(user, 'personnelRead') && <button onClick={() => navigate('/personnel')}>Alla personer</button>}
                {can(user, 'personnelRead') && <button onClick={() => navigate('/personnel/tasks')}>Bemanning att lösa</button>}
                <button className="active" onClick={() => navigate('/personnel/accounts')}>Konton</button>
              </nav>
              <StaffAccountPanel key={`${actualUser!.id}:${user.id}:${query.get('user') ?? ''}`}
                users={data.users} initialUserId={query.get('user') ?? undefined}
                actor={user} sites={terminalDemo.state?.sites} save={saveStaffUsers} />
            </>
          ) : section === 'personnel' ? (
            <Suspense fallback={<div className="office-panel" role="status">Hämtar personalregistret…</div>}><PersonalWorkspace
              key={`${actualUser!.id}:${user.id}`} user={user} actualUser={actualUser!}
              users={data.users} selectedSiteId={siteFilter} onNotice={setMessage}
              onAccountsChanged={() => shared.refresh()}
              renderStaffAccount={id => can(user, 'users') && data.users.some(account => account.id === id) ? <StaffAccountPanel
                key={`${user.id}:${id}`} embedded users={data.users} initialUserId={id}
                actor={user} sites={terminalDemo.state?.sites} save={saveStaffUsers} /> : <p role="status">Hämtar det kopplade kontot…</p>}
              onOpenUser={id => navigate(`/personnel/accounts?user=${encodeURIComponent(id)}`)} /></Suspense>
          ) : section === 'environment' ? (
            <EnvironmentWorkspace user={user} actualUser={actualUser!} siteId={siteFilter} onNotice={setMessage} onOpenCard={open} />
          ) : section === 'facilities' ? (
            <Suspense fallback={<div className="office-panel">Hämtar anläggningar…</div>}><FacilitiesWorkspace user={user} actualUser={actualUser!} onNotice={setMessage} /></Suspense>
          ) : section === 'customer-approvals' ? (
            <CustomerApprovalsWorkspace state={terminalDemo.state} siteId={siteFilter} onOpenCard={open}
              loading={terminalDemo.loading} error={terminalDemo.error} configurationRequired={terminalDemo.configurationRequired}
              onRefresh={terminalDemo.refresh} canSeeMoney={approvalMoneyVisible(user)} />
          ) : section === 'terminals' ? (
            <TerminalWorkspace state={terminalDemo.state} loading={terminalDemo.loading} error={terminalDemo.error}
              configurationRequired={terminalDemo.configurationRequired} onRefresh={terminalDemo.refresh} onNotice={setMessage} />
          ) : section === 'customers' ? (
            <CustomerWorkspace
              data={data}
              user={user}
              actualUser={actualUser!}
              onSaveCustomer={saveCustomer}
              newCustomerDraft={customerCreation?.draft}
              onNewCustomerComplete={finishCustomerCreation}
              onNewCustomerCancel={() => {
                if (customerCreation) navigate(customerCreation.returnRoute);
                setCustomerCreation(undefined);
              }}
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
          {documentType && actualUser && selected && cardMoneyVisible(user, selected) && (
            <OfficeDocument
              user={user}
              actualUser={actualUser}
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
            JEROC Kontorsdemo {OFFICE_VERSION} · Testdata ·{' '}
            <button
              className="office-link"
              onClick={() => window.location.reload()}
            >
              Uppdatera från servern
            </button>
          </footer>
        </main>
      </div>
    </div>
    </EnvironmentSessionProvider>
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
    cell = a?.photos[0];
  if (cell === undefined) return <span className="office-material-image" role="img" aria-label={`${a?.name ?? id} · referensbild saknas`}><Battery size={24} /></span>;
  return (
    <span
      className="office-material-image"
      role="img"
      aria-label={a?.name ?? id}
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
  onDirtyChange,
}: {
  card: OfficeCard;
  disabled: boolean;
  customer?: OfficeCustomer;
  save: (r: string, o: string) => boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [reference, setReference] = useState(card.reference),
    [origin, setOrigin] = useState(card.origin);
  useEffect(() => {
    setReference(card.reference);
    setOrigin(card.origin);
  }, [card.reference, card.origin]);
  useEffect(() => {
    onDirtyChange?.(reference !== card.reference || origin !== card.origin);
  }, [reference, origin, card.reference, card.origin, onDirtyChange]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(reference, origin);
      }}
    >
      <label>
        Referens <span className="office-small">(valfri)</span>
        <input
          aria-label="Referens"
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
        Ursprungsadress <span className="office-small">(krävs före kundgodkännande)</span>
        <input
          aria-label="Ursprungsadress"
          aria-describedby={!disabled ? 'office-origin-requirement' : undefined}
          aria-invalid={
            !disabled && card.customerId && !origin.trim() ? true : undefined
          }
          disabled={disabled || !card.customerId}
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          list="office-origin"
          placeholder="Gatuadressen där materialet kommer ifrån"
        />
      </label>
      {!disabled && (
        <p className="office-small" id="office-origin-requirement">
          {!origin.trim()
            ? 'Ursprungsadress saknas. Fyll i och spara gatuadressen före kundgodkännande.'
            : reference !== card.reference || origin !== card.origin
              ? 'Spara ändringarna innan kundgodkännandet startas.'
              : 'Ursprungsadressen är sparad. Referens är valfri.'}
        </p>
      )}
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
    <section className="office-panel office-card-correction">
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
                {(r.articleName ?? articleById(r.articleId)?.name ?? r.articleId)}
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
