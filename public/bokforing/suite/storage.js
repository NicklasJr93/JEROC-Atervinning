// Reuse the coordinated, read-back-confirmed demo storage. Its own key keeps
// the expanded suite separate from any saved examples in the first demo.
import { createDemoStorage } from '../storage.js';
import { createSuiteState } from './seed.js';
import { validateSuiteState } from './validate.js';

export const STORAGE_KEY = 'scrapplanner-bokforing-suite-v2';

export function createSuiteStorage(options = {}) {
  return createDemoStorage({
    ...options,
    key: STORAGE_KEY,
    createState: createSuiteState,
    validateState: validateSuiteState,
  });
}
