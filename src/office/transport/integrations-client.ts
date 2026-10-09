import { useEffect, useRef, useState } from 'react';
import type { TransportActor, TransportIntegrationEvent } from './types';

export interface TransportOutboxReceipt {
  acceptedIds: string[]; prepared: number; duplicates: number;
  deliveryEnabled: false; memoryOnly: boolean;
}
export interface TransportOutboxState {
  state: 'idle' | 'preparing' | 'prepared' | 'retrying';
  prepared: number; total: number; error: string; retry(): void;
}
/** Uploading prepares the demo outbox. This endpoint cannot send a message. */
export async function prepareTransportEvents(events: TransportIntegrationEvent[], actor: TransportActor, signal?: AbortSignal): Promise<TransportOutboxReceipt> {
  const batches: TransportIntegrationEvent[][] = [];
  let batch: TransportIntegrationEvent[] = [], bytes = 32;
  const encoder = new TextEncoder();
  for (const event of events) {
    const size = encoder.encode(JSON.stringify(event)).length + 1;
    if (batch.length && (batch.length >= 50 || bytes + size > 64000)) { batches.push(batch); batch = []; bytes = 32; }
    batch.push(event); bytes += size;
  }
  if (batch.length) batches.push(batch);
  const summary: TransportOutboxReceipt = { acceptedIds: [], prepared: 0, duplicates: 0, deliveryEnabled: false, memoryOnly: false };
  for (const items of batches) {
    const receipt = await postTransportEvents(items, actor, signal);
    summary.acceptedIds.push(...receipt.acceptedIds); summary.prepared += receipt.prepared; summary.duplicates += receipt.duplicates;
  }
  return summary;
}
async function postTransportEvents(events: TransportIntegrationEvent[], actor: TransportActor, signal?: AbortSignal): Promise<TransportOutboxReceipt> {
  const response = await fetch('/api/transport/outbox', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actor.actualUserId, 'X-Demo-User': actor.effectiveUserId },
    body: JSON.stringify({ events }),
  });
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error('Utkorgen svarade inte. Händelserna finns kvar lokalt.'); }
  if (!response.ok) throw new Error((result as { error?: string }).error || 'Utkorgen kunde inte förberedas.');
  const receipt = result as Partial<TransportOutboxReceipt>;
  if (!Array.isArray(receipt.acceptedIds) || !receipt.acceptedIds.every((id) => typeof id === 'string') || receipt.deliveryEnabled !== false || receipt.memoryOnly !== false || typeof receipt.prepared !== 'number' || typeof receipt.duplicates !== 'number') {
    throw new Error('Utkorgen gav ett ofullständigt svar. Händelserna finns kvar lokalt.');
  }
  return receipt as TransportOutboxReceipt;
}

/** The local ledger remains authoritative during the database-free demo. */
export function useTransportOutbox(events: TransportIntegrationEvent[], actor: TransportActor): TransportOutboxState {
  const acknowledged = useRef<{ scope: string; ids: Set<string> }>({ scope: '', ids: new Set() });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Omit<TransportOutboxState, 'retry'>>({ state: 'idle', prepared: 0, total: 0, error: '' });
  const { canPlan, actualUserId, effectiveUserId } = actor;
  useEffect(() => {
    const scope = `${actualUserId}:${effectiveUserId}`;
    if (acknowledged.current.scope !== scope) acknowledged.current = { scope, ids: new Set() };
    const eligible = events.filter((event) => event.actualUserId === actualUserId && event.effectiveUserId === effectiveUserId);
    if (!canPlan || !eligible.length) {
      setStatus({ state: 'idle', prepared: 0, total: eligible.length, error: '' });
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const identity = { canPlan, actualUserId, effectiveUserId, actor: '' };
    async function send() {
      if (controller.signal.aborted) return;
      const pending = eligible.filter((event) => !acknowledged.current.ids.has(event.id));
      if (!pending.length) { setStatus({ state: 'prepared', prepared: eligible.length, total: eligible.length, error: '' }); return; }
      setStatus({ state: 'preparing', prepared: eligible.length - pending.length, total: eligible.length, error: '' });
      try {
        for (let offset = 0; offset < pending.length; offset += 50) {
          const receipt = await prepareTransportEvents(pending.slice(offset, offset + 50), identity, controller.signal);
          if (controller.signal.aborted) return;
          receipt.acceptedIds.forEach((id) => acknowledged.current.ids.add(id));
        }
        setStatus({ state: 'prepared', prepared: eligible.length, total: eligible.length, error: '' });
      } catch (reason) {
        if (controller.signal.aborted) return;
        const prepared = eligible.filter((event) => acknowledged.current.ids.has(event.id)).length;
        setStatus({ state: 'retrying', prepared, total: eligible.length, error: reason instanceof Error ? reason.message : 'Servern svarade inte.' });
        // Reuse the event IDs on every retry. The server prepares each ID once.
        if (failures < 5) timer = setTimeout(send, Math.min(30000, 2000 * 2 ** failures++));
      }
    }
    void send();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [events, canPlan, actualUserId, effectiveUserId, attempt]);
  return { ...status, retry() { acknowledged.current.ids.clear(); setAttempt((value) => value + 1); } };
}
