// Annual low-remuneration rule: SAL 2:14 and 2:24; SKV AGI fields 010/131/132.
// Historical forecast is explicit. Rates are supplied by the versioned payroll engine.
import { assert, cents, validDate } from './core.js';
export const PAYROLL_ANNUAL_LIMIT_CENTS = 100_000;
export const PAYROLL_ANNUAL_RULE = 'SE-2026-annual-1000-v1';
export const PAYROLL_ANNUAL_SOURCE = 'https://www.skatteverket.se/foretag/arbetsgivare/lamnaarbetsgivardeklaration/safyllerduiarbetsgivardeklarationen.4.2cf1b5cd163796a5c8b66a8.html';
const sum = values => values.reduce((a,b)=>cents(a+cents(b)),0);
/** Events are chronological payments after any explicitly selected gross recoveries. */
export function annualContributionSchedule(events, calculate, { finalBelowThreshold = false } = {}) {
  const periods = new Map(), calculated = [];
  let annualTaxableCents = 0, chargeable = false, pending = [], lastDate = '';
  const total = sum(events.map(item=>sum([item.grossCents,item.benefitCents])));
  assert(!finalBelowThreshold || total < PAYROLL_ANNUAL_LIMIT_CENTS, 'Årsersättningen är minst 1 000 kr och får inte klassas som avgiftsfri.');
  for (const event of events) {
    assert(validDate(event.date) && event.date >= lastDate, 'Årets löneutbetalningar måste behandlas i datumordning.'); lastDate=event.date;
    assert(typeof event.expectedAtLeast1000 === 'boolean', 'Granska förväntad årsersättning.');
    const month = event.date.slice(0,7), taxableCents=sum([event.grossCents,event.benefitCents]);
    annualTaxableCents=sum([annualTaxableCents,taxableCents]);
    const period=periods.get(month)??{month,grossCents:0,benefitCents:0,contributionGrossCents:0,contributionBenefitCents:0,exemptGrossCents:0,exemptBenefitCents:0,previouslyReportedCents:0,employerCents:0,assessedBaseCents:0};
    periods.set(month,period);period.grossCents=sum([period.grossCents,event.grossCents]);period.benefitCents=sum([period.benefitCents,event.benefitCents]);
    // The forecast is recorded for withholding. SAL's contribution threshold follows actual remuneration.
    if (!finalBelowThreshold && (event.legacyAssessed || annualTaxableCents >= PAYROLL_ANNUAL_LIMIT_CENTS)) chargeable=true;
    let employerCents=0,carriedGrossCents=0,carriedBenefitCents=0,previouslyReportedCents=0;
    if (chargeable) {
      for(const prior of pending){
        carriedGrossCents=sum([carriedGrossCents,prior.grossCents]);carriedBenefitCents=sum([carriedBenefitCents,prior.benefitCents]);
        if(prior.month===month){period.exemptGrossCents-=prior.grossCents;period.exemptBenefitCents-=prior.benefitCents;}
        else previouslyReportedCents=sum([previouslyReportedCents,prior.grossCents,prior.benefitCents]);
      }
      const assess=sum([taxableCents,carriedGrossCents,carriedBenefitCents]);
      employerCents=calculate({birthYear:event.birthYear,paymentDate:event.date,taxableCents:assess,previousTaxableCents:period.assessedBaseCents}).contributionCents;
      period.assessedBaseCents=sum([period.assessedBaseCents,assess]);period.employerCents=sum([period.employerCents,employerCents]);
      period.contributionGrossCents=sum([period.contributionGrossCents,event.grossCents,carriedGrossCents]);period.contributionBenefitCents=sum([period.contributionBenefitCents,event.benefitCents,carriedBenefitCents]);
      period.previouslyReportedCents=sum([period.previouslyReportedCents,previouslyReportedCents]);pending=[];
    } else {
      period.exemptGrossCents=sum([period.exemptGrossCents,event.grossCents]);period.exemptBenefitCents=sum([period.exemptBenefitCents,event.benefitCents]);
      pending.push({month,grossCents:event.grossCents,benefitCents:event.benefitCents});
    }
    calculated.push({...event,employerCents,annualTaxableCents,carriedGrossCents,carriedBenefitCents,previouslyReportedCents,thresholdExempt:!chargeable});
  }
  return {ruleVersion:PAYROLL_ANNUAL_RULE,annualTaxableCents,events:calculated,periods:[...periods.values()]};
}
