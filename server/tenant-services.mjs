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
import { createBankPayments } from './bank-payments.mjs';
import { createOpenPaymentsClient } from './openpayments-client.mjs';
import { createMailService } from './mail-service.mjs';
import { createMailApi } from './mail-api.mjs';
import { getPlatformContext } from './platform-auth.mjs';
import { ensurePortalDemoAccounts } from './portal-demo.mjs';
import { createNvvClient } from './nvv-client.mjs';
import { restrictPilotIntegrationService, handlePilotIntegrationRequest } from './pilot-integrations.mjs';
import { can } from '../dist-server/domain-models.mjs';
import { createCompanySettingsService } from './company-settings.mjs';
import { createCompanySettingsApi } from './company-settings-api.mjs';
import { createCompanyLogoService } from './company-logo.mjs';
import { createCompanyLogoApi } from './company-logo-api.mjs';
import { createSystemEmail } from './system-email.mjs';
import { createWeighedDocumentEmail } from './weighed-document-email.mjs';
import { createSystemSmsProvider } from './system-sms-provider.mjs';
import { createCustomerIntakeService } from './customer-intake.mjs';
import { createCustomerIntakeApi } from './customer-intake-api.mjs';
import { employeeCompanyLookupContext, employeeRequestPrincipal } from './mobile-employee-api.mjs';

/** All repositories, queues and provider connections belong to one immutable
 * server-selected organisation. A request can never change this bundle's scope. */
export async function createTenantServices({ env, seed, initialSites, trustedPrincipalProvider, reauthorizeTrustedPrincipal, company, companySettingsAuthorize, weighedDocumentEmailSender,
  registerCustomerApprovalLink, registerCustomerIntakeLink, customerApprovalEmail, customerApprovalSms, customerIntakeCompanyLookup, authorizeCustomerIntakeCompany } = {}) {
  const restrictIntegration = (provider, service) => restrictPilotIntegrationService({ env, provider, service });
  const organisationId = env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? 'jeroc-demo';
  if (organisationId !== 'jeroc-demo' && (!company || company.id !== organisationId || !company.name?.trim()))
    throw new TypeError('Bolagets dokument behöver dess egen servervalda företagsprofil.');
  // Legal identity belongs to the immutable server-selected bundle. Editable
  // contact/branding settings are read afresh only for NEW document snapshots.
  const initialDocumentCompany = Object.freeze({ id: organisationId,
    name: company?.name ?? 'JEROC Återvinning AB', number: company?.organisationNumber ?? company?.number ?? '',
    vat: company?.vat ?? '', address: company?.address ?? '', postalCode: company?.postalCode ?? '', city: company?.city ?? '' });
  const applicationApi = createApplicationService({ env, seed, approvalProvider: () => terminalDemoApi.projections(),
    voiceTestCompanyName: initialDocumentCompany.name, companyProfileProvider: () => documentCompany(),
    reauthorizeVoiceCall: async (state, call, req) => {
      const platform = getPlatformContext(req);
      if (!platform || platform.organisationId !== organisationId || typeof reauthorizeTrustedPrincipal !== 'function')
        throw new PricingError('En aktiv session i bolaget krävs för rösttestet.', 403);
      const trusted = await reauthorizeTrustedPrincipal(req);
      if (trusted.actorId !== platform.actualUser.id || trusted.userId !== platform.user.id || trusted.sessionKey !== platform.sessionKey)
        throw new PricingError('Röstsamtalets session eller bolag har ändrats.', 403);
      return resolvePricingPrincipal(state.pricing?.users ?? [], trusted.actorId, trusted.userId);
    },
    projections: cardId => terminalDemoApi.projections(cardId),
    sendCustomerReview: (payload, principal, req) => terminalDemoApi.sendPrepared(payload, principal, req),
    finishCustomerReview: (approvalId, req) => terminalDemoApi.deliverPrepared(approvalId, req),
    withMaterialChangeApproval: (input, identity, operation) => terminalDemoApi.withMaterialChangeApproval(input, identity, operation),
    guardMaterialChange: (input, operation) => environmentApi.guardMaterialChange(input, operation),
    siteProvider: () => environmentApi.getSites(),
    environmentProvider: () => environmentApi.getLogisticsSource(),
    accountingSettingsProvider: customer => vismaService.financeSettingsForCompany(customer),
    accountingCardStatusProvider: cardId => vismaService.cardExportProjection(cardId),
    managedPaymentGuard: async (cardId, state) => {
      await swishService.assertNoManagedPayment(cardId, state);
      await bankService.assertNoManagedPayment(cardId, state);
      throw new PricingError('Använd utbetalningskortets verifierade betalningsflöde. Äldre manuell demoregistrering är avstängd.', 409);
    },
    validateArticleMedia: async (route, input) => {
      const references = getArticleMediaReferences(route, input);
      if (references.length && !await articleMediaApi.hasImages(references))
        throw new PricingError('En uppladdad bild saknas. Ladda upp bilden igen innan du sparar.', 422);
    },
  });
  const companyLogoService = createCompanyLogoService({ env, organisationId });
  const companySettingsService = createCompanySettingsService({ organisationId,
    company: { ...company, ...initialDocumentCompany, organisationNumber: initialDocumentCompany.number },
    getRepository: () => applicationApi.getRepository(), validateLogo: id => companyLogoService.hasLogo(id) });
  const authorizeCompanySettings = companySettingsAuthorize ?? (async () => { throw new PricingError('Logga in i bolaget för att öppna företagsinställningarna.', 401); });
  const companySettingsApi = createCompanySettingsApi({ service: companySettingsService, authorize: authorizeCompanySettings });
  const companyLogoApi = createCompanyLogoApi({ service: companyLogoService, authorize: authorizeCompanySettings });
  const documentCompany = () => companySettingsService.documentProfile();
  const principalStore = applicationApi.principalStore;
  const articleMediaApi = createArticleMediaApi({ env, authorize: req => applicationApi.withPrincipal(() => {
    const actor = req.headers['x-demo-actor'];
    const user = req.headers['x-demo-user'] ?? actor;
    if (typeof actor !== 'string' || typeof user !== 'string')
      throw new PricingError('Välj ett giltigt konto innan du laddar upp en bild.', 401);
    return principalStore.principal(actor, user);
  }) });
  const vismaService = restrictIntegration('visma', createVismaSandbox({ env, getRepository: () => applicationApi.getRepository(),
    sourceProvider: request => terminalDemoApi.documentProjections(request), sitesProvider: () => environmentApi.getSites(),
    swishPaymentProvider: async id => (await swishService.readVerifiedPayment(id)) ?? bankService.readVerifiedPayment(id),
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
  }));
  const swishService = restrictIntegration('swish', createSwishPayments({ env, getRepository: () => applicationApi.getRepository(),
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
  }));
  const bankService = restrictIntegration('bank', createBankPayments({ env, getRepository: () => applicationApi.getRepository(),
    client: createOpenPaymentsClient({ env }),
    sourceProvider: request => terminalDemoApi.documentProjections(request),
    sitesProvider: () => environmentApi.getSites(),
    authorizeContext: async context => {
      if (typeof context.reauthorize !== 'function') throw new PricingError('En aktiv betalningssession krävs.', 403);
      const principal = await context.reauthorize();
      if (principal.actor.id !== context.actorId || principal.user.id !== context.effectiveUserId)
        throw new PricingError('Betalningssessionen har ändrats.', 403);
    },
    onPrepared: job => job.kind === 'card' && job.reason ? documentsApi.archivePaymentRevision(job) : undefined,
    assertPaymentReady: (source, options) => vismaService.assertPaymentReady(source, options),
    onPaymentConfirmed: job => documentsApi.archivePaymentConfirmation(job),
    onVerifiedPayment: (job, options) => vismaService.synchronizeSwishPayment(job.id, options),
  }));
  const resolveMailContext = async req => {
    const platform = getPlatformContext(req);
    if (!platform || platform.organisationId !== organisationId || typeof reauthorizeTrustedPrincipal !== 'function')
      throw new PricingError('Logga in i bolaget för att öppna mejlen.', 401);
    const context = { organisationId, actorId: platform.actualUser.id, effectiveUserId: platform.user.id,
      sessionKey: platform.sessionKey, csrfToken: platform.csrfToken };
    context.reauthorize = async () => {
      const trusted = await reauthorizeTrustedPrincipal(req);
      if (trusted.actorId !== context.actorId || trusted.userId !== context.effectiveUserId || trusted.sessionKey !== context.sessionKey)
        throw new PricingError('Mejlsessionen eller bolaget har ändrats. Ladda om sidan.', 403);
      return (await applicationApi.getRepository()).read(state => resolvePricingPrincipal(state.pricing?.users ?? [], context.actorId, context.effectiveUserId), { domains: ['pricing'] });
    };
    await context.reauthorize(); return context;
  };
  const mailService = restrictIntegration('mail', createMailService({ env, getRepository: () => applicationApi.getRepository(),
    authorizeContext: async context => {
      if (context.organisationId !== organisationId || typeof context.reauthorize !== 'function') throw new PricingError('En verifierad mejlsession krävs.', 403);
      const principal = await context.reauthorize();
      if (principal.actor.id !== context.actorId || principal.user.id !== context.effectiveUserId) throw new PricingError('Mejlsessionen har ändrats.', 403);
    },
  }));
  const mailApi = createMailApi({ service: mailService, organisationId, resolveContext: resolveMailContext });
  // A narrow, explicit company opt-in for office copies. It does not enable
  // the generic mailbox, Spiris, bank or other blocked pilot integrations.
  const weighedDocumentEmailService = createWeighedDocumentEmail({ organisationId,
    getRepository: () => applicationApi.getRepository(),
    readDocument: id => documentsApi.readArchivedDocumentForEmail(id),
    email: weighedDocumentEmailSender ?? createSystemEmail({ env }),
  });
  const environmentApi = createEnvironmentApi({ env, initialSites, trustedPrincipalProvider: reauthorizeTrustedPrincipal ?? trustedPrincipalProvider, principalStore,
    ...(env.SCRAPPLANNER_DEPLOYMENT_MODE === 'pilot' && { nvvClient: createNvvClient({ env: {} }) }),
    vismaService, swishService, bankService, mailService,
    approvalGuard: (input, operation) => terminalDemoApi.withApprovedCard(input, operation),
    outboundProvider: async () => (await applicationApi.getRepository()).read(state =>
      (state.logistics?.inventoryMovements ?? []).filter(row => row.kind === 'outbound' && row.hazardous)
        .map(row => ({ id: row.id, siteId: row.siteId, articleId: row.articleId, wasteCode: row.wasteCode,
          weight: row.kg, receivedAt: row.at, kind: 'outbound', sourceId: row.sourceId })), { domains: ['logistics'] }),
  });
  const remoteProviders = { email: customerApprovalEmail ?? createSystemEmail({ env }), sms: customerApprovalSms ?? createSystemSmsProvider({ env }) };
  const terminalDemoApi = createTerminalDemoApi({ env, trustedPrincipalProvider, principalStore, companyProfileProvider: documentCompany, siteProvider: () => environmentApi.getSites(),
    remoteConfigured: channel => Boolean(registerCustomerApprovalLink && remoteProviders[channel]?.configured && typeof remoteProviders[channel]?.sendCustomerApproval === 'function'),
    remoteDelivery: async job => {
      try { await registerCustomerApprovalLink({ tokenHash: job.tokenHash, approvalId: job.approvalId, expiresAt: job.expiresAt }); }
      catch { return { status: 'failed', errorCode: 'customer_approval_link_registration_failed' }; }
      const approvalUrl = new URL('/godkann/', env.APP_URL || 'https://app.scrapplanner.com'); approvalUrl.hash = `token=${job.token}`;
      try {
        await remoteProviders[job.channel].sendCustomerApproval({ to: job.to, requestId: job.requestId, companyName: job.companyName,
          approvalUrl: approvalUrl.href, createdAt: job.createdAt, expiresAt: job.expiresAt });
        return { status: 'sent' };
      } catch (error) {
        const certain = typeof error?.code === 'string' && /^system_(email|sms)_/.test(error.code) && !error.code.includes('outcome_unknown');
        return { status: certain ? 'failed' : 'unknown' };
      }
    },
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
    onApprovalChanged: async (approval, job) => {
      if (!job) return documentsApi.ensureApproval(approval);
      const document = await documentsApi.archiveApprovalJob(approval,
        { ...job, companySnapshot: job.companySnapshot ?? approval.companySnapshot ?? structuredClone(initialDocumentCompany) });
      if (job.stage === 'final') {
        // Persist the email decision before acknowledging the durable PDF job.
        // Provider requests run independently after the archive/queue commits.
        await weighedDocumentEmailService.enqueue(approval, document);
        setImmediate(() => { void weighedDocumentEmailService.processQueuedWeighedDocumentEmails()
          .catch(() => console.warn('Mejlkopian av vägt underlag väntar på nästa kontroll.')); });
      }
      return document;
    },
  });
  const documentsApi = createDocumentsApi({ env,
    renderPdf: async snapshot => {
      if (!snapshot.company?.logoId) return renderPdf(snapshot);
      // Resolve only the immutable asset referenced by this frozen snapshot.
      // A later profile/logo change cannot substitute the latest company mark.
      const logo = await companyLogoService.read(snapshot.company.logoId);
      if (!logo) throw new PricingError('Dokumentets sparade företagslogga saknas. Försök igen.', 409, 'company_logo_missing');
      return renderPdf(snapshot, { logoBytes: logo.bytes });
    },
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
        return { company: await documentCompany(), initialCompany: structuredClone(initialDocumentCompany), pricing: { articles: await repository.readArticleNames(request.articleIds) } };
      }
      // A durable PDF job already supplies its frozen business/approval source.
      // Older jobs need only the facility, never all current application history.
      if (request.kind === 'approval-job') return { company: structuredClone(initialDocumentCompany), initialCompany: structuredClone(initialDocumentCompany), sites: await environmentApi.getSites() };
      if (request.kind === 'approval') {
        const [approvals, sites] = await Promise.all([
          terminalDemoApi.documentProjections({ cardId: Number(request.sourceId), approvalId: request.approvalId }),
          environmentApi.getSites(),
        ]);
        return { company: await documentCompany(), initialCompany: structuredClone(initialDocumentCompany), approvals, sites };
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
      return { ...source, company: await documentCompany(), initialCompany: structuredClone(initialDocumentCompany), approvals, sites };
    },
  });

    const deliverIntakeSms = Object.assign(async job => {
      const url = new URL('/kunduppgifter/', env.APP_URL || 'https://app.scrapplanner.com');
      url.hash = `token=${job.token}`;
      return remoteProviders.sms.sendCustomerIntake({ to: job.to, requestId: job.requestId,
        companyName: job.companyName, intakeUrl: url.href, createdAt: job.createdAt, expiresAt: job.expiresAt });
    }, { configured: remoteProviders.sms.configured === true && typeof remoteProviders.sms.sendCustomerIntake === 'function' });
    const customerIntakeService = createCustomerIntakeService({ repository: await applicationApi.getRepository(),
      authorizeStaff: (req, state, { write = false } = {}) => {
        // Includes the authenticated employee/person fence; supplied names or
        // tenant selectors never substitute for an actual session.
        employeeCompanyLookupContext(state, req);
        return employeeRequestPrincipal(state, req, { enforceGate: write });
      },
      terminalAccess: terminalDemoApi,
      companyProfileProvider: async () => ({ id: organisationId, name: (await documentCompany()).name }),
      registerLink: registerCustomerIntakeLink,
      deliverSms: deliverIntakeSms,
    });
    const customerIntakeApi = createCustomerIntakeApi({ service: customerIntakeService, terminalAccess: terminalDemoApi,
      companyLookup: customerIntakeCompanyLookup, organisationId, authorizeCompany: authorizeCustomerIntakeCompany });
    try {
      await applicationApi.getRepository();
      await vismaService.initialize();
      await articleMediaApi.ready();
      await environmentApi.initialize();
      const [sites, source] = await Promise.all([environmentApi.getSites(), environmentApi.getLogisticsSource()]);
      await (await applicationApi.getRepository()).transact(state => {
        ensureLogistics(state, { sites, ...source });
        ensurePortalDemoAccounts(state, env);
        // This identity has no password/personnel account and can only be selected
        // by the authenticated platform support administrator.
        if (!state.pricing.users.some(user => user.id === '__platform-admin')) {
          // JEROC previously used its personnel-linked admin for own platform
          // authority. Retain that account's financial policy as starting values
          // without changing its staff permissions, site scope or credentials.
          const legacyAdmin = organisationId === 'jeroc-demo'
            ? state.pricing.users.find(user => user.id === 'admin' && user.level === 'Systemadmin' && user.active !== false) : undefined;
          const user = { id: '__platform-admin', name: 'Systemadmin', level: 'Systemadmin', permissions: [],
            maxAttest: legacyAdmin && Number.isFinite(legacyAdmin.maxAttest) && legacyAdmin.maxAttest >= 0 ? legacyAdmin.maxAttest : 0,
            ownAttest: legacyAdmin ? legacyAdmin.ownAttest === true : true, active: true };
          state.pricing.users.push(user); state.office.users.push(structuredClone(user));
        }
      });
      await terminalDemoApi.initialize();
      await swishService.initialize();
      await bankService.initialize();
    } catch (error) { await close(); throw error; }
    async function close() {
      await terminalDemoApi.close();
      await weighedDocumentEmailService.close();
      await Promise.allSettled([environmentApi.close(), applicationApi.close(), documentsApi.close(), articleMediaApi.close(), companyLogoService.close()]);
    }
    return { applicationApi, customerIntakeService, articleMediaApi, companySettingsService, companyLogoService, weighedDocumentEmailService, vismaService, swishService, bankService, mailService, resolveMailContext, environmentApi, terminalDemoApi, documentsApi, close,
      async handle(req, res, url) {
        if (handlePilotIntegrationRequest(env, req, res, url)) return true;
        if (await companySettingsApi(req, res, url)) return true;
        if (await companyLogoApi(req, res, url)) return true;
        if (await mailApi(req, res, url)) return true;
        if (await articleMediaApi(req, res, url)) return true;
        if (await customerIntakeApi(req, res, url)) return true;
        if (await applicationApi(req, res, url)) return true;
        if (await documentsApi(req, res, url)) return true;
        if (await terminalDemoApi(req, res, url)) return true;
        return environmentApi(req, res, url);
      },
    };
}
