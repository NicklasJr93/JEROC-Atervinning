// Application-level permissions for the local agency demonstration. The
// coordinator checks these again when committing. They are not server auth.
import { hasPermission } from './agency.js';

const read = Object.freeze(['read']);
const owner = Object.freeze(['manage']);
const need = (...permissions) => Object.freeze(['read', ...permissions]);
const book = need('bookkeeping');
const payroll = need('payroll');
const payment = need('payments');
const close = need('closing');
const payrollPayment = need('payroll', 'payments');
const taxPayment = need('closing', 'payments');
const exportBasic = need('export');
const exportPayroll = need('payroll', 'export');
const exportClosing = need('closing', 'export');
const exportFull = need('payroll', 'closing', 'export');

const viewReads = {
  overview: read, setup: read, projects: read, sales: read, purchases: read,
  ledger: read, bank: read, assets: read, inventory: read, accruals: read,
  reports: read, commercial: read, settlements: read, fx: read, cash: read,
  sie: read, vat: read, 'tax-v2': read,
  payroll, 'payroll-v2': payroll,
  close, 'year-end': close,
  declarations: need('payroll', 'closing'),
};

const viewWrites = {
  overview: book, setup: owner, projects: book, sales: book, purchases: book,
  ledger: book, bank: payment, assets: book, inventory: book, accruals: book,
  reports: book, commercial: book, settlements: book, fx: book, cash: book,
  sie: book, vat: close, 'tax-v2': close,
  payroll, 'payroll-v2': payroll,
  close, 'year-end': close,
  declarations: need('payroll', 'closing'),
};

const readActions = new Set([
  'close-dialog', 'reload', 'toggle-assistant', 'show-entry', 'show-invoice',
  'invoice-back', 'show-bill', 'purchase-back', 'purchase-inbox',
  'open-document-inbox', 'close-document-picker', 'close-inbox-preview',
  'reload-documents', 'select-document', 'select-inbox-document',
  'document-zoom-in', 'document-zoom-out', 'document-rotate', 'document-reset',
  'vat-filter',
]);

const ordinaryActions = Object.create(null);
function mapActions(names, permissions) {
  for (const name of names.split(' ')) ordinaryActions[name] = permissions;
}
mapActions('new-empty-company edit-company company reset start-cash', owner);
mapActions('new-invoice edit-invoice copy-invoice add-invoice-line remove-invoice-line add-line remove-line new-customer new-project project-item new-quote accept-quote invoice-quote issue-invoice credit-invoice remind-invoice credit-bill manual-entry correct-entry add-entry-row remove-entry-row new-asset depreciate-asset dispose-asset new-stock stock-movement value-stock new-accrual accrual-month invoice-page customer project quote asset stock-item stock-value accrual', book);
mapActions('new-bill edit-bill copy-bill create-bill-from-document open-document-picker attach-document unlink-document remove-inbox-document link-document-existing book-bill purchase-add-line purchase-remove-line purchase-page document-upload document-picker link-document purchase-book', book);
mapActions('new-employee new-payroll post-payroll employee payroll', payroll);
mapActions('pay-payroll settle-payroll-taxes', payrollPayment);
mapActions('invoice-payment bill-payment new-bank bank bank-match book-bank', payment);
mapActions('request-rot decide-rot file-vat lock-period unlock-period close-year', close);
mapActions('settle-vat', taxPayment);
mapActions('export-ledger export-reports print-invoice download-document', exportBasic);
mapActions('export-agi', exportPayroll);
mapActions('export-review', exportFull);
mapActions('vat-filter', read);

const features = {
  commercial: {
    'save-article': book, 'activate-article': book, 'deactivate-article': book,
    'save-price': book, 'article-invoice': book, 'create-recurring': book,
    'generate-recurring': book, 'pause-recurring': book, 'activate-recurring': book,
    reminder: book, 'project-stock': book, 'create-revenue': book,
    'recognize-revenue': book, workpaper: book,
  },
  settlements: {
    credit: book, 'preview-special-credit': book,
    // This can confirm a corrected ROT/tax treatment as well as a credit.
    'confirm-special-credit': need('bookkeeping', 'closing'),
    refund: payment, offset: book,
  },
  'payroll-v2': {
    profile: payroll, create: payroll, post: payroll, discard: payroll,
    'discard-legacy': payroll, reverse: payroll, 'vacation-year': payroll,
    recovery: payroll, 'annual-contribution-review': payroll,
    pay: payrollPayment, 'settle-tax': payrollPayment,
    'recovery-payment': payrollPayment, 'recovery-tax': payrollPayment,
    'annual-contribution-settle': payrollPayment,
  },
  'tax-v2': {
    'set-tax-period': close, 'file-vat': close, 'post-tax': close,
    'reverse-tax': close, 'create-rot-plan': close, 'prepare-rot': close,
    'decide-rot': close, 'prepare-corrected-rot': close,
    'decide-corrected-rot': close,
    'settle-vat': taxPayment, 'receive-rot': taxPayment, 'repay-rot': taxPayment,
    'receive-corrected-rot': taxPayment, 'repay-corrected-rot': taxPayment,
  },
  'year-end': {
    'save-workpaper': close, 'lock-period': close, 'close-year': close,
    'open-next-year': close, 'calculate-tax': exportClosing,
    'export-annual': exportClosing, 'export-year': exportFull,
  },
  fx: {
    create: book, edit: book, 'remove-draft': book, issue: book, credit: book,
    revalue: close, 'reverse-revalue': close,
    pay: payment, refund: payment,
    print: exportBasic, 'print-credit': exportBasic,
  },
  cash: {
    'start-cash': owner, 'save-document': book, issue: book, delete: book,
    'year-end': close, payment, credit: book, refund: payment,
    print: exportBasic, 'print-credit': exportBasic,
  },
  sie: { import: book, export: exportBasic, receipt: exportBasic },
  declarations: {
    'create-agi': payroll, 'create-vat': close,
    'create-sru': close, 'create-annual': close,
    // The selected document may be AGI. Without inspecting the stored document
    // and its type, require both scopes rather than accidentally exporting it.
    export: exportFull,
  },
};

const copy = permissions => [...permissions];
const merge = (...permissions) => [...new Set(permissions.flat())];
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;

/** Minimum scope to render a page, including entry through a direct hash. */
export function neededViews(view) {
  if (view === 'agency') return [];
  return copy(own(viewReads, view) || owner);
}

export function canView(directory, userId, companyId, view) {
  if (view === 'agency') {
    return Boolean(directory?.users?.some(user => user.id === userId && user.active));
  }
  if (!Object.hasOwn(viewReads, view)) return false;
  return neededViews(view).every(permission => hasPermission(directory, userId, companyId, permission));
}

/** True only for known navigation/local-display operations, never downloads. */
export function isReadAction(action) {
  return readActions.has(action);
}

/**
 * A feature name is required for generic actions such as `create` and `pay`.
 * Unrecognised feature/action/form names are owner-only until explicitly mapped.
 * `form` is the data-form value; confirm-action callers pass the hidden action.
 */
export function requiredPermissions({ view, action, form, feature, isDownload = false } = {}) {
  const name = action || form;
  let permissions;
  if (feature) {
    if (!Object.hasOwn(features, feature)) return copy(owner);
    if (!name) permissions = own(viewWrites, feature);
    else permissions = own(features[feature], name);
  } else if (name) {
    permissions = readActions.has(name) ? read : ordinaryActions[name];
  } else {
    permissions = own(viewWrites, view);
  }
  if (!permissions) return copy(owner);
  if (permissions.includes('manage')) return copy(owner);
  // Do not let a permission shortcut render or export a restricted workspace.
  const page = own(viewReads, view) || (view === undefined || view === 'agency' ? [] : owner);
  if (page.includes('manage')) return copy(owner);
  return merge(permissions, page, isDownload ? ['export'] : []);
}
