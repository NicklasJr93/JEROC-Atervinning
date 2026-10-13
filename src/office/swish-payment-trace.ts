import type { OfficeUser } from './model';
import type { SwishPaymentJob } from './swish-payments-client';

const titles: Record<string, string> = {
  payment_reserved: 'Testutbetalning påbörjad · Swish MSS',
  payment_sent: 'Utbetalning skickas till Swish MSS',
  payment_pending: 'Inväntar Swishs slutstatus',
  payment_rejected: 'Swish MSS avvisade testutbetalningen',
  payment_blocked: 'Testutbetalning stoppad',
  payment_not_sent: 'Testutbetalning kunde inte skickas',
  payment_outcome_unknown: 'Utbetalningens resultat behöver kontrolleras',
  payment_response_mismatch: 'Utbetalningens svar behöver granskas',
  payment_preflight_blocked: 'Kontroll inför utbetalning stoppad',
  payment_preflight_ready: 'Kontroll inför utbetalning godkänd',
  payment_resumed: 'Samma testutbetalning återupptagen',
  payment_details_overridden: 'Betalningsuppgifter ändrade med orsak',
  payment_simulated_paid: 'Testutbetalning genomförd · Swish MSS',
  payment_confirmation_pdf_archived: 'PDF med betalningsbekräftelse arkiverad',
  payment_confirmation_pdf_failed: 'Betalningsbekräftad PDF behöver åtgärdas',
};

export type PaymentTraceItem = { key: string; at: string; text: string; actor: string; detail: string; order: number };

/** Display persisted events, including earlier attempts, without deriving
 * payment success or rejection from a mutable current job status. */
export function swishPaymentTrace(jobs: SwishPaymentJob[], users: OfficeUser[]): PaymentTraceItem[] {
  const items: PaymentTraceItem[] = [], seen = new Set<string>();
  const name = (id: string, job: SwishPaymentJob) => users.find(user => user.id === id)?.name
    ?? (id === job.reservedBy?.actualUserId ? job.reservedBy.actualUserName : undefined)
    ?? (id === job.reservedBy?.effectiveUserId ? job.reservedBy.effectiveUserName : undefined)
    ?? id;
  const attempts = [...jobs].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (const [attemptIndex, job] of attempts.entries()) {
    const occurrences = new Map<string, number>();
    for (const event of job.events ?? []) {
      if (!event?.at || !Number.isFinite(Date.parse(event.at))) continue;
      const action = event.action ?? event.type ?? '';
      const title = action === 'payment_bookkeeping_updated'
        ? event.status === 'registered' ? 'Testbetalning registrerad i Spiris sandbox' : undefined
        : titles[action];
      if (!title) continue;
      const identity = JSON.stringify([event.at, action, event.text ?? event.message, event.actualUserId, event.effectiveUserId]);
      const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
      const key = `swish-${job.id}-${event.id ?? identity + '/' + occurrence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const actual = event.actualUserId, effective = event.effectiveUserId;
      const actor = !actual || actual.startsWith('service:') ? event.actor ?? 'Swish MSS · automatik'
        : effective && effective !== actual ? `${name(actual, job)} (jobbar som ${name(effective, job)})` : name(actual, job);
      const reason = ['payment_rejected', 'payment_blocked', 'payment_not_sent', 'payment_outcome_unknown',
        'payment_response_mismatch', 'payment_preflight_blocked', 'payment_details_overridden', 'payment_confirmation_pdf_failed'].includes(action)
        ? event.error?.message || event.text || event.message : undefined;
      const source = job.source ? `Avräkning AV-${job.source.cardId}-V${job.source.version}` : 'Swish MSS-test';
      const reference = action === 'payment_simulated_paid' && job.providerPaymentReference ? ` · Swish-referens ${job.providerPaymentReference}` : '';
      items.push({ key, at: event.at, text: title, actor,
        detail: `${source} · Försök ${attemptIndex + 1}${reference}${reason && reason !== title ? ' · ' + reason : ''}`, order: items.length });
    }
  }
  return items;
}
