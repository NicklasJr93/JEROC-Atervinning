import { isAbsolute, join, resolve } from 'node:path';

const databaseNames = ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT',
  'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO', 'SICKNESS_FILES', 'FLEET_FILES'];
const inheritedRuntimeKeys = /^(?:PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|CI|TERM|COLORTERM|FORCE_COLOR|NO_COLOR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;

/** Browser tests never inherit database URLs, provider credentials, NODE_OPTIONS
 * or an existing installation's data paths. Only runtime/proxy/CA selectors
 * survive; all business storage belongs to this disposable directory. */
export function browserTestEnvironment(inherited, directory, runId) {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    throw new TypeError('Browser tests require an absolute disposable directory.');
  if (!/^[a-f0-9-]{36}$/i.test(runId ?? ''))
    throw new TypeError('Browser tests require a per-run marker.');
  const env = Object.fromEntries(Object.entries(inherited)
    .filter(([key, value]) => inheritedRuntimeKeys.test(key) && typeof value === 'string'));
  Object.assign(env, {
    NODE_ENV: 'test', SCRAPPLANNER_DEPLOYMENT_MODE: 'demo',
    SCRAPPLANNER_BROWSER_TEST: 'true', SCRAPPLANNER_TEST_RUN_ID: runId,
    SCRAPPLANNER_TEST_DATA_DIR: directory, JEROC_TENANT_DATA_DIR: directory,
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Browser-Isolation-Initial-2026!',
    TELEMATICS_SQLITE_PATH: join(directory, 'telematics-receiver.sqlite'),
    EXPO_GO_ENABLED: 'false', PORT: '3000',
  });
  for (const name of databaseNames)
    env[`JEROC_${name}_DB_PATH`] = join(directory, `${name.toLowerCase()}.sqlite`);
  return env;
}

export function browserTestMarker(env) {
  if (env.SCRAPPLANNER_BROWSER_TEST !== 'true' || !env.SCRAPPLANNER_TEST_RUN_ID)
    throw new TypeError('The server is not a disposable browser-test environment.');
  return { kind: 'scrapplanner-browser-test', runId: env.SCRAPPLANNER_TEST_RUN_ID, disposable: true };
}
