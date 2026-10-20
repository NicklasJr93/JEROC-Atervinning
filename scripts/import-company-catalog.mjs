import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createPlatformStorage } from '../server/platform-storage.mjs';
import { createApplicationRepository } from '../server/application-storage.mjs';
import { createArticleMediaRepository } from '../server/article-media-storage.mjs';
import { tenantRuntimeEnvironment } from '../server/tenant-runtime.mjs';
import { assertCatalogImportDeployment, CatalogImportError, checkCatalogImportReadiness, decodeCatalogImport, decodeCatalogImportTarget, importCompanyCatalog,
  selectCatalogImportCompany } from '../server/catalog-import.mjs';

/** Run as a Render one-off job with the payload in a temporary secret variable.
 * This deliberately has no HTTP endpoint or credential-based auto-login. */
export async function runCatalogImport({ args = process.argv.slice(2), env = process.env, log = value => console.log(JSON.stringify(value)) } = {}) {
  assertCatalogImportDeployment(env);
  const checkTarget = args.includes('--check-target'), cleaned = args.filter(value => value !== '--check-target');
  if (cleaned.length !== 2 || cleaned[0] !== '--payload-env' || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(cleaned[1])
    || args.filter(value => value === '--check-target').length > 1) throw new CatalogImportError('catalog_import_arguments_invalid');
  const input = checkTarget ? decodeCatalogImportTarget(env[cleaned[1]]) : decodeCatalogImport(env[cleaned[1]]);
  let control, repository, media;
  try {
    control = await createPlatformStorage({ env });
    const company = await control.read(state => selectCatalogImportCompany(state.companies, input));
    const scopedEnv = tenantRuntimeEnvironment(env, company);
    repository = await createApplicationRepository({ env: scopedEnv, seed: () => { throw new CatalogImportError('catalog_import_existing_database_required'); } });
    if (checkTarget) {
      const result = await checkCatalogImportReadiness({ repository, input, company });
      log({ checked: true, matchingActiveCompanies: 1, ...result }); return;
    }
    const validateImages = async images => {
      for (const image of images.filter(value => typeof value === 'number')) {
        try {
          await Promise.all(['thumb', 'full'].map(variant => access(new URL(`../public/images/catalog/${image}-${variant}.webp`, import.meta.url))));
        } catch { throw new CatalogImportError('catalog_import_image_missing'); }
      }
      const uploaded = images.filter(value => typeof value === 'string');
      if (uploaded.length) {
        media ??= await createArticleMediaRepository({ env: scopedEnv });
        if (!await media.hasImages(uploaded)) throw new CatalogImportError('catalog_import_image_missing');
      }
    };
    const result = await importCompanyCatalog({ repository, input, company, validateImages });
    // Deliberately omit article names, prices, payload, database URL and secrets.
    log({ verified: result.verified, duplicate: result.duplicate, companyId: result.companyId,
      importId: result.importId, articleCount: result.articleCount, groupCount: result.groupCount });
  } finally { await Promise.allSettled([repository?.close(), media?.close(), control?.close()]); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCatalogImport(); }
  catch (error) {
    // Validator/driver errors may contain original values. Never print them.
    console.error(JSON.stringify({ verified: false, code: error instanceof CatalogImportError ? error.code : 'catalog_import_failed' }));
    process.exitCode = 1;
  }
}
