import { createApplicationService } from './application.mjs';
import { createTerminalDemoApi } from './terminal-demo.mjs';
import { createEnvironmentApi } from './environment-api.mjs';
import { createDocumentsApi } from './documents/api.mjs';
import { renderPdf } from './documents/render-pool.mjs';
import { PricingError, getArticleMediaReferences, resolvePricingPrincipal } from './pricing.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';
import { canManageVisma } from './visma-client.mjs';
import { createArticleMediaApi } from './article-media.mjs';
import { ensureLogistics } from './logistics.mjs';
import { createSwishMssClient } from './swish-client.mjs';
import { createSwishPayments } from './swish-payments.mjs';
import { can } from '../dist-server/domain-models.mjs';

/** All repositories, queues and provider connections belong to one immutable
 * server-selected organisation. A request can never change this bundle's scope. */
export async function createTenantServices({ env, seed, initialSites, trustedPrincipalProvider, reauthorizeTrustedPrincipal, company } = {}) {
  const organisationId = env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? 'jeroc-demo';
  if (organisationId !== 'jeroc-demo' && (!company || company.id !== organisationId || !company.name?.trim()))
    throw new TypeError('Bolagets dokument behöver dess egen servervalda företagsprofil.');
  // Legal company identity belongs to the immutable service bundle. It is never
  // supplied by a browser, inherited from JEROC, or changed by a support selection.
  const documentCompany = Object.freeze({ id: organisationId,
    name: company?.name ?? 'JEROC Återvinning AB', number: company?.organisationNumber ?? company?.number ?? '',
    vat: company?.vat ?? '', address: company?.address ?? '', postalCode: company?.postalCode ?? '', city: company?.city ?? '' });
  const applicationApi = createApplicationService({ env, seed, approvalProvider: () => terminalDemoApi.projections(),
    projections: cardId => terminalDemoApi.projections(cardId),
    sendCustomerReview: (payload, principal, req) => terminalDemoApi.sendPrepared(payload, principal, req),
    withMaterialChangeApproval: (input, identity, operation) => terminalDemoApi.withMaterialChangeApproval(input, identity, operation),
    guardMaterialChange: (input, operation) => environmentApi.guardMaterialChange(input, operation),
    siteProvider: () => environmentApi.getSites(),
    environmentProvider: () => environmentApi.getLogisticsSource(),
    accountingSettingsProvider: customer => vismaService.financeSettingsForCompany(customer),
    accountingCardStatusProvider: cardId => vismaService.cardExportProjection(cardId),
    managedPaymentGuard: async (cardId, state) => {
      await swishService.assertNoManagedPayment(cardId, state);
      throw new PricingError('Använd utbetalningskortets verifierade betalningsflöde. Äldre manuell demoregistrering är avstängd.', 409);
    },
    validateArticleMedia: async (route, input) => {
      const references = getArticleMediaReferences(route, input);
      if (references.length && !await articleMediaApi.hasImages(references))
        throw new PricingError('En uppladdad bild saknas. Ladda upp bilden igen innan du sparar.', 422);
    },
  });
  const principalStore = applicationApi.principalStore;
  const articleMediaApi = createArticleMediaApi({ env, authorize: req => applicationApi.withPrincipal(() => {
    const actor = req.headers['x-demo-actor'];
    const user = req.headers['x-demo-user'] ?? actor;
    if (typeof actor !== 'string' || typeof user !== 'string')
      throw new PricingError('Välj ett giltigt konto innan du laddar upp en bild.', 401);
    return principalStore.principal(actor, user);
  }) });
  const vismaService = createVismaSandbox({ env, getRepository: () => applicationApi.getRepository(),
    sourceProvider: request => terminalDemoApi.documentProjections(request), sitesProvider: () => environmentApi.getSites(),
    swishPaymentProvider: id => swishService.readVerifiedPayment(id),
    authorizeBookingContext: async (context, { cardId, siteId, write = false } = {}) => {
      if (context?.organisationId !== organisationId || !context.actorId || !context.effectiveUserId)
        throw new PricingError('Bokföringsåtgärden tillhör inte detta bolag.', 403);
      if (typeof context.reauthorize === 'function') {
        const current = await context.reauthorize();
        if (current.actor.id !== context.actorId || current.user.id !== context.effectiveUserId)
          throw new PricingError('Bokföringssessionen har ändrats.', 403);
      }
      return (await applicationApi.getRepository()).read(state => {
        const principal = resolvePricingPrincipal(state.pricing?.users ?? [], context.actorId, context.effectiveUserId);
        const allowed = write ? ['bookSpiris'] : ['bookSpiris', 'attest', 'pay'];
        if (!allowed.some(right => can(principal.actor, right) && can(principal.user, right)))
          throw new PricingError(write ? 'Behörighet att bokföra i Spiris krävs.' : 'Behörighet till attest, bokföring eller utbetalning krävs.', 403);
        const currentSite = siteId ?? state.office?.cards?.find(card => String(card.id) === String(cardId))?.siteId;
        if (!currentSite || [principal.actor, principal.user].some(user => Array.isArray(user.siteIds) && !user.siteIds.includes(currentSite)))
          throw new PricingError('Du saknar åtkomst till underlagets anläggning.', 403);
        return principal;
      }, { domains: ['pricing', 'office'] });
    },
    authorizeContext: async context => {
      if (typeof context.reauthorize !== 'function') throw new PricingError('Den aktiva integrationssessionen saknas.', 403);
      const session = await context.reauthorize();
      if (session.actor.id !== context.actorId || session.user.id !== context.effectiveUserId) throw new PricingError('Integrationssessionen har ändrats.', 403);
      if (!canManageVisma(session.actor) || !canManageVisma(session.user) || session.actor.siteIds || session.user.siteIds)
        throw new PricingError('Behörighet att hantera integrationer med åtkomst till företagets samtliga anläggningar krävs.', 403);
    },
  });
  const swishService = createSwishPayments({ env, getRepository: () => applicationApi.getRepository(),
    client: createSwishMssClient({ env }),
    sourceProvider: request => terminalDemoApi.documentProjections(request),
    sitesProvider: () => environmentApi.getSites(),
    authorizeContext: async context => {
      if (typeof context.reauthorize !== 'function') throw new PricingError('En aktiv betalningssession krävs.', 403);
      const principal = await context.reauthorize();
      if (principal.actor.id !== context.actorId || principal.user.id !== context.effectiveUserId)
        throw new PricingError('Betalningssessionen har ändrats.', 403);
    },
    onPrepared: job => job.kind === 'card' && job.reason
      ? documentsApi.archivePaymentRevision(job) : undefined,
    assertPaymentReady: (source, options) => vismaService.assertPaymentReady(source, options),
    onPaymentConfirmed: job => documentsApi.archivePaymentConfirmation(job),
    onVerifiedPayment: (job, options) => vismaService.synchronizeSwishPayment(job.id, options),
  });
  const environmentApi = createEnvironmentApi({ env, initialSites, trustedPrincipalProvider: reauthorizeTrustedPrincipal ?? trustedPrincipalProvider, principalStore,
    vismaService, swishService,
    approvalGuard: (input, operation) => terminalDemoApi.withApprovedCard(input, operation),
    outboundProvider: async () => (await applicationApi.getRepository()).read(state =>
      (state.logistics?.inventoryMovements ?? []).filter(row => row.kind === 'outbound' && row.hazardous)
        .map(row => ({ id: row.id, siteId: row.siteId, articleId: row.articleId, wasteCode: row.wasteCode,
          weight: row.kg, receivedAt: row.at, kind: 'outbound', sourceId: row.sourceId })), { domains: ['logistics'] }),
  });
  const terminalDemoApi = createTerminalDemoApi({ env, trustedPrincipalProvider, principalStore, siteProvider: () => environmentApi.getSites(),
    environmentApprovalCheck: approval => environmentApi.assertReceiptForAttest(approval),
    accountingSourceProvider: async request => {
      const customer = await (await applicationApi.getRepository()).read(state => structuredClone(state.office.customers.find(value => value.id === request.customer.id)), { domains: ['office'] });
      const settings = await vismaService.financeSettingsForCompany(customer);
      if (!settings) return null;
      return { settings, customer };
    },
    onAttested: approval => vismaService.processQueuedExports({ cardId: approval.cardId, reconcile: false }),
    attestBookingCheck: (approval, principal) => vismaService.checkAttestBooking(approval, {
      organisationId, actorId: principal.actor.id, effectiveUserId: principal.user.id,
    }),
    onApprovalChanged: (approval, job) => job
      ? documentsApi.archiveApprovalJob(approval, { ...job, companySnapshot: structuredClone(documentCompany) })
      : documentsApi.ensureApproval(approval),
  });
  const documentsApi = createDocumentsApi({ env,
    renderPdf,
    resolvePrincipal: req => principalStore.runFreshPrincipal(() => {
      const actor = req.headers['x-demo-actor'];
      const user = req.headers['x-demo-user'] ?? actor;
      if (typeof actor !== 'string' || typeof user !== 'string')
        throw new PricingError('Välj ett giltigt demokonto.', 401);
      return principalStore.principal(actor, user);
    }),
    sourceProvider: async (request = {}) => {
      if (request.kind === 'article-names') {
        const repository = await applicationApi.getRepository();
        return { company: structuredClone(documentCompany), pricing: { articles: await repository.readArticleNames(request.articleIds) } };
      }
      // A durable PDF job already supplies its frozen business/approval source.
      // Older jobs need only the facility, never all current application history.
      if (request.kind === 'approval-job') return { company: structuredClone(documentCompany), sites: await environmentApi.getSites() };
      if (request.kind === 'approval') {
        const [approvals, sites] = await Promise.all([
          terminalDemoApi.documentProjections({ cardId: Number(request.sourceId), approvalId: request.approvalId }),
          environmentApi.getSites(),
        ]);
        return { company: structuredClone(documentCompany), approvals, sites };
      }
      const repository = await applicationApi.getRepository();
      // Release the application aggregate before reading the terminal/environment
      // aggregates. No nested cross-module locks while rendering or archiving PDF.
      const transport = request.kind === 'transport';
      const readSource = async () => {
        const logistics = transport && repository.readProjection
          ? await repository.readProjection(state => state.logistics ?? { details: {} }, { domain: 'logistics', paths: [['details', String(request.sourceId)]] }) : undefined;
        return repository.read(state => {
          if (logistics) state.logistics = logistics;
          const payments = request.kind === 'receipt' ? state.office.payments.filter(value => String(value.id) === String(request.sourceId)) : [];
          const cardId = request.kind === 'receipt' ? payments[0]?.cardId : request.sourceId;
          const cards = transport ? [] : state.office.cards.filter(value => String(value.id) === String(cardId));
          const orders = transport ? state.transport.orders.filter(order => order.id === request.sourceId) : [];
          const customers = state.office.customers.filter(customer => cards.some(card => card.customerId === customer.id) || orders.some(order => order.customerId === customer.id));
          const drivers = transport ? state.transport.drivers.filter(driver => orders.some(order => order.driverId === driver.id || state.logistics?.details?.[order.id]?.assignedDriverId === driver.id)) : [];
          return structuredClone({ office: { cards, customers, payments },
            ...(transport ? {
              transport: { orders, drivers, vehicles: state.transport.vehicles.filter(vehicle => orders.some(order => order.vehicleId === vehicle.id || state.logistics?.details?.[order.id]?.assignedVehicleId === vehicle.id)) },
              personnel: { companies: state.personnel.companies.filter(company => drivers.some(driver => driver.companyId === company.id) || state.logistics?.details?.[request.sourceId]?.carrierId === company.id) },
              logistics: { details: state.logistics?.details?.[request.sourceId] ? { [request.sourceId]: state.logistics.details[request.sourceId] } : {} },
            } : {}),
          });
        }, { domains: transport ? ['office', 'transport', 'personnel', ...(logistics ? [] : ['logistics'])] : ['office'] });
      };
      const source = await (repository.runInReadTransaction ? repository.runInReadTransaction(readSource) : readSource());
      const [approvals, sites] = await Promise.all([
        transport ? [] : terminalDemoApi.documentProjections({ cardId: Number(source.office.cards[0]?.id ?? source.office.payments[0]?.cardId ?? request.sourceId) }),
        environmentApi.getSites(),
      ]);
      return { ...source, company: structuredClone(documentCompany), approvals, sites };
    },
  });

    try {
      await applicationApi.getRepository();
      await vismaService.initialize();
      await articleMediaApi.ready();
      await environmentApi.initialize();
      const [sites, source] = await Promise.all([environmentApi.getSites(), environmentApi.getLogisticsSource()]);
      await (await applicationApi.getRepository()).transact(state => {
        ensureLogistics(state, { sites, ...source });
        // This identity has no password/personnel account and can only be selected
        // by the authenticated platform support administrator.
        if (env.SCRAPPILOT_ORGANISATION_ID !== 'jeroc-demo' && !state.pricing.users.some(user => user.id === '__platform-admin')) {
          const user = { id: '__platform-admin', name: 'Systemadmin', level: 'Systemadmin', permissions: [], maxAttest: 0, ownAttest: true, active: true };
          state.pricing.users.push(user); state.office.users.push(structuredClone(user));
        }
      });
      await terminalDemoApi.initialize();
      await swishService.initialize();
    } catch (error) { await close(); throw error; }
    async function close() {
      await Promise.allSettled([terminalDemoApi.close(), environmentApi.close(), applicationApi.close(), documentsApi.close(), articleMediaApi.close()]);
    }
    return { applicationApi, articleMediaApi, vismaService, swishService, environmentApi, terminalDemoApi, documentsApi, close,
      async handle(req, res, url) {
        if (await articleMediaApi(req, res, url)) return true;
        if (await applicationApi(req, res, url)) return true;
        if (await documentsApi(req, res, url)) return true;
        if (await terminalDemoApi(req, res, url)) return true;
        return environmentApi(req, res, url);
      },
    };
}
