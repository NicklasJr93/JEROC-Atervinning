import type { OfficeUser } from './model';
import type { BankPaymentJob } from './bank-payments-client';
import type { PaymentTraceItem } from './swish-payment-trace';

const titles: Record<string, string> = {
  payment_reserved: 'Banktest påbörjat · Open Payments', bank_payment_reserved: 'Banktest påbörjat · Open Payments',
  payment_sent: 'Betalningsinstruktion skickad till testbanken', bank_payment_sent: 'Betalningsinstruktion skickad till testbanken',
  payment_authorisation_started: 'Bankens godkännande påbörjat', bank_authorisation_started: 'Bankens godkännande påbörjat',
  payment_authorisation_reserved: 'Bankens godkännande påbörjat', payment_authorisation_completed: 'Bankens godkännande mottaget',
  payment_authorisation_unknown: 'Bankens godkännande behöver kontrolleras',
  payment_authorisation_required: 'Inväntar godkännande i testbanken',
  payment_awaiting_authorization: 'Inväntar godkännande i testbanken', bank_payment_authorization_required: 'Inväntar godkännande i testbanken',
  payment_pending: 'Inväntar bankens slutstatus', bank_payment_pending: 'Inväntar bankens slutstatus',
  payment_rejected: 'Testbanken avvisade utbetalningen', bank_payment_rejected: 'Testbanken avvisade utbetalningen',
  payment_blocked: 'Banktest stoppat', bank_payment_blocked: 'Banktest stoppat', payment_not_sent: 'Banktest kunde inte skickas',
  payment_outcome_unknown: 'Bankens resultat behöver kontrolleras', bank_payment_unknown: 'Bankens resultat behöver kontrolleras',
  payment_response_mismatch: 'Bankens svar behöver granskas', payment_preflight_blocked: 'Kontroll inför bankutbetalning stoppad',
  payment_preflight_ready: 'Kontroll inför bankutbetalning godkänd',
  payment_resumed: 'Samma banktest återupptaget', payment_details_overridden: 'Bankmottagare ändrad med orsak',
  payment_simulated_paid: 'Testutbetalning genomförd · Open Payments', bank_payment_simulated_paid: 'Testutbetalning genomförd · Open Payments',
  payment_confirmation_pdf_archived: 'PDF med bankens testbekräftelse arkiverad', payment_confirmation_pdf_failed: 'PDF med bankens testbekräftelse behöver åtgärdas',
};

/** Project persisted events; a current job state cannot fabricate a historical outcome. */
export function bankPaymentTrace(jobs: BankPaymentJob[], users: OfficeUser[]): PaymentTraceItem[] {
  const items: PaymentTraceItem[] = [], seen = new Set<string>();
  const name = (id: string, job: BankPaymentJob) => users.find(user => user.id === id)?.name
    ?? (id === job.reservedBy?.actualUserId ? job.reservedBy.actualUserName : undefined)
    ?? (id === job.reservedBy?.effectiveUserId ? job.reservedBy.effectiveUserName : undefined) ?? id;
  const attempts = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const [attemptIndex, job] of attempts.entries()) {
    const occurrences = new Map<string, number>();
    for (const event of job.events ?? []) {
      if (!event.at || !Number.isFinite(Date.parse(event.at))) continue;
      const action = event.action ?? event.type ?? '';
      const title = action === 'payment_bookkeeping_updated' || action === 'bank_payment_bookkeeping_updated'
        ? event.status === 'registered' ? 'Banktestets betalning registrerad i Spiris sandbox' : undefined : titles[action];
      if (!title) continue;
      const identity = JSON.stringify([event.at, action, event.text ?? event.message, event.actualUserId, event.effectiveUserId]);
      const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
      const key = `bank-${job.id}-${event.id ?? identity + '/' + occurrence}`;
      if (seen.has(key)) continue; seen.add(key);
      const actual = event.actualUserId, effective = event.effectiveUserId;
      const actor = !actual || actual.startsWith('service:') ? event.actor ?? 'Open Payments · automatik'
        : effective && effective !== actual ? `${name(actual, job)} (jobbar som ${name(effective, job)})` : name(actual, job);
      const problem = /rejected|blocked|not_sent|unknown|overridden|failed/.test(action) ? event.error?.message || event.text || event.message : undefined;
      const source = job.source ? `Avräkning AV-${job.source.cardId}-V${job.source.version}` : 'Banktest';
      const reference = /simulated_paid/.test(action) && job.providerPaymentReference ? ` · Bankreferens ${job.providerPaymentReference}` : '';
      items.push({ key, at: event.at, text: title, actor, order: items.length,
        detail: `${source} · Försök ${attemptIndex + 1}${reference}${problem && problem !== title ? ' · ' + problem : ''}` });
    }
  }
  return items;
}
