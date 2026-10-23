import * as Settlements from './credit-workspace.js';
import * as Payroll from './payroll-workspace.js';
import * as Tax from './tax-workspace.js';
import * as YearEnd from './year-workspace.js';
import * as Commercial from './commercial-workspace.js';
import * as Sie from './sie-workspace.js';
import * as Fx from './fx-workspace.js';
import * as Cash from './cash-workspace.js';
import * as Declarations from './declarations-workspace.js';

export const featureModules = Object.freeze({
  settlements: Settlements, 'payroll-v2': Payroll, 'tax-v2': Tax,
  'year-end': YearEnd, commercial: Commercial, sie: Sie, fx: Fx, cash: Cash, declarations: Declarations,
});
export const featureNavigation = Object.freeze([
  ['settlements', 'Krediter & återbetalningar'],
  ['commercial', 'Artiklar & avtal'],
  ['payroll-v2', 'Lön'], ['tax-v2', 'Moms & ROT'], ['year-end', 'Bokslut & räkenskapsår'],
  ['fx', 'Valutafakturor'], ['cash', 'Kontantmetoden'], ['sie', 'SIE · import/export'],
  ['declarations', 'Deklarationer & årsredovisning'],
]);

export function featureData(formOrButton) {
  if (formOrButton instanceof HTMLFormElement) return Object.fromEntries(new FormData(formOrButton));
  return { ...formOrButton.dataset };
}

export function featureDownload(state, feature, action, data) {
  return featureModules[feature]?.getDownload?.(state, action, data) ?? null;
}
