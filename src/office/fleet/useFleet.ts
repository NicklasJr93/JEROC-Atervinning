import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OfficeUser } from '../model';
import { changeFleet, fleetAccessDeniedEvent, FleetApiError, fleetScope, mayReadFleet, readFleet } from './client';
import type { FleetAction, FleetActionInput, FleetState } from './types';

export function useFleet(user: OfficeUser, actualUser: OfficeUser) {
  const captured = fleetScope(user, actualUser), scope = useMemo(() => captured, [captured.key]);
  const readable = mayReadFleet(user, actualUser), key = `${scope.key}:${readable}`;
  const current = useRef(key); current.current = key;
  const mounted = useRef(true), controllers = useRef(new Set<AbortController>()), reads = useRef<Promise<FleetState> | undefined>(undefined), readVersion = useRef(0);
  const pending = useRef(false), retries = useRef(new Map<string, FleetAction>());
  const [snapshot, setSnapshot] = useState<{ key: string; value: FleetState }>();
  const [status, setStatus] = useState<{ key: string; loading?: boolean; busy?: boolean; error?: string }>({ key, loading: true });
  const state = readable && snapshot?.key === key && snapshot.value.capabilities.read ? snapshot.value : undefined;
  const latest = useRef(state); latest.current = state;
  const accept = useCallback((value: FleetState) => { if (mounted.current && current.current === key) setSnapshot(previous => previous?.key === key && previous.value.revision > value.revision ? previous : { key, value }); }, [key]);
  const load = useCallback((): Promise<FleetState> => {
    if (reads.current) return reads.current;
    const controller = new AbortController(), sequence = ++readVersion.current; controllers.current.add(controller);
    const promise = readFleet(scope, controller.signal).then(value => {
      if (!mounted.current || current.current !== key || controller.signal.aborted) throw new DOMException('Vyn har ändrats.', 'AbortError');
      if (sequence === readVersion.current) { accept(value); setStatus(previous => ({ ...previous, key, loading: false, error: undefined })); }
      return value;
    }).catch(reason => {
      if (mounted.current && current.current === key && !controller.signal.aborted) {
        if (reason instanceof FleetApiError && [401, 403].includes(reason.status)) setSnapshot(undefined);
        setStatus(previous => ({ ...previous, key, loading: false, error: reason instanceof Error ? reason.message : 'Fordonsuppgifterna kunde inte hämtas.' }));
      } throw reason;
    }).finally(() => { controllers.current.delete(controller); if (reads.current === promise) reads.current = undefined; });
    reads.current = promise; return promise;
  }, [key, scope, accept]);
  useEffect(() => {
    mounted.current = true; setSnapshot(undefined); setStatus({ key, loading: readable }); pending.current = false; retries.current.clear();
    if (readable) void load().catch(() => {});
    const refresh = () => { if (!document.hidden && readable && !pending.current) void load().catch(() => {}); };
    const denied = (event: Event) => {
      if ((event as CustomEvent<{ scopeKey: string }>).detail?.scopeKey !== scope.key) return;
      ++readVersion.current; for (const controller of controllers.current) controller.abort(); reads.current = undefined;
      setSnapshot(undefined); setStatus({ key, loading: false, busy: false, error: 'Din åtkomst till fordonsuppgifterna har ändrats. Uppdatera vyn.' });
    };
    const interval = window.setInterval(refresh, 20000); document.addEventListener('visibilitychange', refresh);
    window.addEventListener(fleetAccessDeniedEvent, denied);
    const active = controllers.current;
    return () => { mounted.current = false; ++readVersion.current; for (const controller of active) controller.abort(); active.clear(); reads.current = undefined; window.clearInterval(interval); document.removeEventListener('visibilitychange', refresh); window.removeEventListener(fleetAccessDeniedEvent, denied); };
  }, [key, readable, load]);
  const run = useCallback(async (input: FleetActionInput, expectedRevision?: number) => {
    if (!readable || !latest.current || pending.current) throw new Error('En ändring sparas redan, eller vyn behöver uppdateras.');
    const fingerprint = JSON.stringify([key, input, expectedRevision ?? null]);
    let command = retries.current.get(fingerprint);
    if (!command) { command = { ...input, expectedRevision: expectedRevision ?? latest.current.revision, requestId: crypto.randomUUID() }; retries.current.set(fingerprint, command); }
    const controller = new AbortController(); controllers.current.add(controller); ++readVersion.current;
    pending.current = true; setStatus(previous => ({ ...previous, key, busy: true, error: undefined }));
    try {
      const value = await changeFleet(scope, command, controller.signal);
      if (!mounted.current || current.current !== key || controller.signal.aborted) throw new DOMException('Vyn har ändrats.', 'AbortError');
      accept(value); retries.current.delete(fingerprint); return value;
    } catch (reason) {
      if (mounted.current && current.current === key && reason instanceof FleetApiError) {
        if ([401, 403].includes(reason.status)) setSnapshot(undefined);
        if (reason.status === 409) { retries.current.delete(fingerprint); void load().catch(() => {}); }
      } throw reason;
    } finally { controllers.current.delete(controller); if (mounted.current && current.current === key) { pending.current = false; setStatus(previous => ({ ...previous, key, busy: false })); } }
  }, [key, scope, readable, accept, load]);
  return { scope, state, readable, loading: status.key === key && status.loading, busy: status.key === key && status.busy, error: status.key === key ? status.error : undefined, refresh: load, run };
}
export type FleetRunner = ReturnType<typeof useFleet>['run'];
