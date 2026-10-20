import type { FullConfig } from '@playwright/test';

/** Refuse mutating tests unless this run owns the disposable app server. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (baseURL !== 'http://127.0.0.1:5173') throw new Error('Browser tests require the isolated local server.');
  const response = await fetch(`${baseURL}/__scrapplanner_test__/marker`, { signal: AbortSignal.timeout(5000) });
  const marker: unknown = await response.json();
  if (!response.ok || typeof marker !== 'object' || marker === null
    || !('kind' in marker) || marker.kind !== 'scrapplanner-browser-test'
    || !('disposable' in marker) || marker.disposable !== true
    || !('runId' in marker) || marker.runId !== process.env.SCRAPPLANNER_TEST_RUN_ID) {
    throw new Error('Refusing browser tests: the server is not this run’s disposable environment.');
  }
}
