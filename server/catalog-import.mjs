import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { createPricingStore, resolvePricingPrincipal } from './pricing.mjs';

const text = maximum => z.string().trim().min(1).max(maximum).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const image = z.union([z.number().int().min(0).max(9999), z.string().uuid()]);
const amount = z.number().finite().min(0).max(1000000).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const nameKey = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv-SE');
const organisationNumber = value => String(value ?? '').replace(/[ -]/g, '');
const thresholds = z.object({ A: z.number().finite().min(0).max(1e9), B: z.number().finite().min(0).max(1e9) }).strict().refine(value => value.A > value.B);
const groupProposalSchema = z.object({ key: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/), name: text(100),
  description: z.string().trim().max(1000), photo: image.nullable() }).strict();
const targetSchema = z.object({
  version: z.literal(1), importId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/),
  company: z.object({ name: text(300), organisationNumber: z.string().regex(/^\d{10}$/) }).strict(),
  groups: z.array(groupProposalSchema).max(1000).default([]),
  articles: z.array(z.object({ name: text(300), group: text(100) })).max(1000).default([]),
});
const schema = z.object({
  version: z.literal(1), importId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._:-]+$/),
  company: z.object({ name: text(300), organisationNumber: z.string().regex(/^\d{10}$/) }).strict(),
  effectiveFrom: date, thresholds,
  groups: z.array(groupProposalSchema).min(1).max(1000),
  articles: z.array(z.object({ name: text(300), group: text(100), description: z.string().trim().max(1000),
    includes: z.array(text(1000)).max(20), excludes: z.array(text(1000)).max(20),
    photos: z.array(image).max(6).refine(values => new Set(values).size === values.length),
    taxCategory: z.enum(['scrap_reverse', 'standard_25', 'no_vat', 'review']),
    prices: z.object({ A: amount, B: amount, C: amount }).strict(),
  }).strict()).min(1).max(1000),
}).strict();

export class CatalogImportError extends Error {
  constructor(code) { super(code); this.name = 'CatalogImportError'; this.code = code; }
}
const fail = code => { throw new CatalogImportError(code); };

export function assertCatalogImportDeployment(env) {
  if (env.RENDER_SERVICE_ID !== 'srv-dbba71vf3r2c7384cm7g' || env.SCRAPPLANNER_DEPLOYMENT_MODE !== 'pilot'
    || env.APP_URL !== 'https://app.scrapplanner.com' || !env.DATABASE_URL) fail('catalog_import_deployment_mismatch');
  try { if (!['postgres:', 'postgresql:'].includes(new URL(env.DATABASE_URL).protocol)) fail('catalog_import_deployment_mismatch'); }
  catch { fail('catalog_import_deployment_mismatch'); }
}

export function parseCatalogImport(input) {
  const result = schema.safeParse(input);
  if (!result.success) fail('catalog_import_payload_invalid');
  const payload = result.data;
  if (new Set(payload.groups.map(value => value.key)).size !== payload.groups.length
    || new Set(payload.groups.map(value => nameKey(value.name))).size !== payload.groups.length
    || new Set(payload.articles.map(value => nameKey(value.name))).size !== payload.articles.length) fail('catalog_import_duplicate_names');
  const keys = new Set(payload.groups.map(value => value.key));
  if (payload.articles.some(value => !keys.has(value.group))) fail('catalog_import_group_missing');
  return payload;
}

/** Target checks deliberately require no price/threshold decision and never
 * pass their partial result to the actual import operation. */
export function parseCatalogImportTarget(input) {
  const result = targetSchema.safeParse(input);
  if (!result.success) fail('catalog_import_payload_invalid');
  return { ...result.data, articleCount: result.data.articles.length, groupCount: result.data.groups.length };
}

/** Payloads are supplied privately to the one-off job, never embedded in source. */
function decodeCompressedJson(value) {
  if (typeof value !== 'string' || !value.length || value.length > 2 * 1024 * 1024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) fail('catalog_import_encoding_invalid');
  try {
    const bytes = gunzipSync(Buffer.from(value, 'base64'), { maxOutputLength: 1024 * 1024 });
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof CatalogImportError) throw error;
    fail('catalog_import_encoding_invalid');
  }
}
export const decodeCatalogImport = value => parseCatalogImport(decodeCompressedJson(value));
export const decodeCatalogImportTarget = value => parseCatalogImportTarget(decodeCompressedJson(value));

export function selectCatalogImportCompany(companies, input) {
  const payload = parseCatalogImportTarget(input);
  const matches = companies.filter(value => value.status === 'active' && value.id !== 'jeroc-demo'
    && nameKey(value.name ?? '') === nameKey(payload.company.name)
    && organisationNumber(value.organisationNumber ?? value.number) === payload.company.organisationNumber);
  if (matches.length !== 1) fail(matches.length ? 'catalog_import_company_ambiguous' : 'catalog_import_company_missing');
  return structuredClone(matches[0]);
}

const fingerprint = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const articlePayload = (article, payload, groupIds) => ({
  name: article.name, category: groupIds[article.group], description: article.description,
  includes: article.includes, excludes: article.excludes, photos: article.photos, active: true, taxCategory: article.taxCategory,
  base: { type: 'manual', price: article.prices.A },
  tiers: Object.fromEntries(['A', 'B', 'C'].map(tier => [tier, { discountPercent: 0, adjustmentKr: article.prices[tier] - article.prices.A }])),
  thresholds: payload.thresholds, effectiveFrom: payload.effectiveFrom,
});

function assertStoredCompany(state, payload, company) {
  if (state.metadata?.organisation?.id !== company.id
    || nameKey(state.metadata.organisation.name ?? '') !== nameKey(payload.company.name)
    || organisationNumber(state.metadata.organisation.number) !== payload.company.organisationNumber) fail('catalog_import_tenant_mismatch');
}

function assertEmptyCatalog(state) {
  if (['articleHistory', 'snapshots', 'ledger', 'customerPrices', 'users', 'groups'].some(field => !Array.isArray(state.pricing?.[field]))
    || state.pricing.articleHistory.length || state.pricing.snapshots.length || state.pricing.ledger.length
    || state.pricing.customerPrices.length) fail('catalog_import_catalog_not_empty');
}

function compatibleGroup(groups, group) {
  const matches = groups.filter(value => nameKey(value.name) === nameKey(group.name));
  if (matches.length > 1) fail('catalog_import_group_conflict');
  const existing = matches[0];
  if (existing && (!existing.active || existing.parentId || existing.name !== group.name
    || existing.description !== group.description || existing.photo !== group.photo)) fail('catalog_import_group_conflict');
  return existing;
}

/** Read-only preflight for an existing tenant, even while price thresholds are
 * still being decided. No pricing store migration or transaction is performed. */
export async function checkCatalogImportReadiness({ repository, input, company }) {
  const proposal = parseCatalogImportTarget(input), target = selectCatalogImportCompany([company], proposal);
  if (!proposal.articles.length || !proposal.groups.length
    || new Set(proposal.groups.map(group => group.key)).size !== proposal.groups.length
    || new Set(proposal.groups.map(group => nameKey(group.name))).size !== proposal.groups.length
    || new Set(proposal.articles.map(article => nameKey(article.name))).size !== proposal.articles.length
    || proposal.articles.some(article => !proposal.groups.some(group => group.key === article.group))) fail('catalog_import_payload_invalid');
  return repository.read(state => {
    assertStoredCompany(state, proposal, target); assertEmptyCatalog(state);
    let support;
    try { support = resolvePricingPrincipal(state.pricing.users, '__platform-admin'); }
    catch { fail('catalog_import_support_principal_missing'); }
    if (support.actor.level !== 'Systemadmin' || support.user.level !== 'Systemadmin') fail('catalog_import_support_principal_missing');
    for (const group of proposal.groups) compatibleGroup(state.pricing.groups, group);
    return { ready: true, companyId: target.id, articleCount: proposal.articleCount, groupCount: proposal.groupCount,
      existingArticleHistoryCount: state.pricing.articleHistory.length, existingGroupCount: state.pricing.groups.length };
  });
}

function verifiedState(state, payload, company, payloadHash) {
  assertStoredCompany(state, payload, company);
  const markers = state.metadata?.catalogImports ?? [];
  const matches = markers.filter(value => value.importId === payload.importId), marker = matches[0];
  if (matches.length !== 1 || marker.payloadHash !== payloadHash || marker.companyId !== company.id
    || marker.sourceReference !== payload.importId || marker.articleCount !== payload.articles.length
    || marker.groups?.length !== payload.groups.length || marker.articles?.length !== payload.articles.length) fail('catalog_import_marker_conflict');
  const pricing = createPricingStore({ initialState: state.pricing });
  const principal = pricing.principal('__platform-admin');
  const current = pricing.read(principal, payload.effectiveFrom);
  if (current.articles.filter(value => value.active).length !== payload.articles.length
    || new Set(marker.articles.map(value => value.id)).size !== payload.articles.length
    || new Set(marker.groups.map(value => value.id)).size !== payload.groups.length) fail('catalog_import_verification_failed');
  const groupIds = Object.fromEntries(marker.groups.map(value => [value.key, value.id]));
  for (const expected of payload.groups) {
    const saved = current.groups.find(value => value.id === groupIds[expected.key]);
    if (!saved || saved.name !== expected.name || saved.description !== expected.description || saved.photo !== expected.photo
      || !saved.active || saved.parentId) fail('catalog_import_verification_failed');
  }
  for (const expected of payload.articles) {
    const mapping = marker.articles.find(value => value.name === expected.name);
    const saved = current.articles.find(value => value.id === mapping?.id);
    if (!saved || saved.revisionId !== mapping.revisionId
      || state.pricing.articleHistory.filter(value => value.id === mapping.id).length !== 1) fail('catalog_import_verification_failed');
    const wanted = articlePayload(expected, payload, groupIds);
    for (const key of Object.keys(wanted)) if (!isDeepStrictEqual(saved[key], wanted[key])) fail('catalog_import_verification_failed');
    if (!isDeepStrictEqual(saved.prices, expected.prices)) fail('catalog_import_verification_failed');
  }
  return { importId: marker.importId, companyId: company.id, articleCount: marker.articleCount,
    groupCount: marker.groups.length, articleIds: marker.articles.map(value => value.id), verified: true };
}

/** All mutations, generated identities and the receipt share the repository's
 * durable transaction. No old pricing/financial/personnel domain is replaced. */
export async function importCompanyCatalog({ repository, input, company, validateImages = async images => {
  if (images.some(value => typeof value === 'string')) fail('catalog_import_image_validator_missing');
}, now = () => new Date() }) {
  const payload = parseCatalogImport(input), payloadHash = fingerprint(payload);
  const target = selectCatalogImportCompany([company], payload);
  const images = [...new Set([...payload.groups.map(value => value.photo), ...payload.articles.flatMap(value => value.photos)].filter(value => value !== null))];
  await validateImages(images);
  let duplicate = false;
  await repository.transact((state, _, audit = []) => {
    assertStoredCompany(state, payload, target);
    const markers = state.metadata.catalogImports ?? [];
    if (markers.some(value => value.importId === payload.importId)) {
      verifiedState(state, payload, target, payloadHash); duplicate = true; return;
    }
    assertEmptyCatalog(state);
    const pricing = createPricingStore({ initialState: state.pricing });
    const principal = pricing.principal('__platform-admin');
    const groupIds = Object.create(null);
    for (const [index, group] of payload.groups.entries()) {
      const existing = compatibleGroup(state.pricing.groups, group);
      if (existing) {
        groupIds[group.key] = existing.id;
      } else {
        const result = pricing.saveArticleGroup({ group: { name: group.name, description: group.description,
          photo: group.photo, sortOrder: index * 10, active: true } }, principal);
        groupIds[group.key] = result.groups.find(value => value.name === group.name).id;
      }
    }
    const savedArticles = [];
    for (const article of payload.articles) {
      pricing.saveArticle(articlePayload(article, payload, groupIds), principal);
      // Future-dated rows need not appear in today's price projection yet.
      const saved = pricing.exportState().articleHistory.at(-1);
      savedArticles.push({ name: article.name, id: saved.id, revisionId: saved.revisionId });
    }
    state.pricing = pricing.exportState();
    (state.metadata.catalogImports ??= []).push({ importId: payload.importId, payloadHash, sourceReference: payload.importId,
      companyId: target.id, articleCount: payload.articles.length, appliedAt: now().toISOString(),
      groups: payload.groups.map(value => ({ key: value.key, id: groupIds[value.key] })), articles: savedArticles });
    audit.push({ action: 'catalog.imported', importId: payload.importId, payloadHash, companyId: target.id,
      actorId: '__platform-admin', source: 'private-render-one-off-job', articleCount: payload.articles.length });
    verifiedState(state, payload, target, payloadHash);
  });
  // An independent read after COMMIT is mandatory before declaring success.
  const verified = await repository.read(state => verifiedState(state, payload, target, payloadHash));
  return { ...verified, duplicate };
}
