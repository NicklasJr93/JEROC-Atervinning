import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficeUser } from './model';
import { TerminalDemoError, terminalDemoApi } from './terminal-demo-client';
import { parseTerminalApproval, parseTerminalDemoState, type TerminalApproval, type TerminalDemoState } from './terminal-demo-types';
import { notifyBusinessChange, notifyBusinessConnection } from '../shared-data';

// Cookie changes must finish in order, including when "Jobba som" changes quickly.
let staffSessionQueue: Promise<unknown> = Promise.resolve();

export function useTerminalDemo(actualUser: OfficeUser | undefined, user: OfficeUser | undefined) {
  const principal = actualUser && user ? `${actualUser.id}/${user.id}` : '';
  const permissions = `${user?.level}/${user?.permissions.join(',')}/${user?.siteIds?.join(',') ?? 'all'}`;
  const principalRef = useRef(principal); principalRef.current = principal;
  const identityRef = useRef({ actor: actualUser?.id, user: user?.id }); identityRef.current = { actor: actualUser?.id, user: user?.id };
  const generation = useRef(0), requestSerial = useRef(0), readyPrincipal = useRef('');
  const valueRef = useRef<{ principal: string; state: TerminalDemoState } | undefined>(undefined);
  const flight = useRef<{ principal: string; generation: number; promise: Promise<void>; controller: AbortController } | undefined>(undefined);
  const [value, setValue] = useState<{ principal: string; state: TerminalDemoState }>();
  const [loading, setLoading] = useState(Boolean(principal));
  const [error, setError] = useState('');
  const [configurationRequired, setConfigurationRequired] = useState(false);

  const acceptState = useCallback((payload: unknown, key: string, expectedGeneration: number) => {
    if (!key || principalRef.current !== key || readyPrincipal.current !== key || generation.current !== expectedGeneration) return false;
    const state = parseTerminalDemoState(payload);
    if ((state.actualUserId && state.actualUserId !== identityRef.current.actor) ||
        (state.effectiveUserId && state.effectiveUserId !== identityRef.current.user)) return false;
    const previous = valueRef.current?.principal === key ? valueRef.current.state : undefined;
    if (previous && state.revision < previous.revision) return false;
    // A mutation response can precede an older in-flight read of that approval.
    // Keep the acknowledged status until the authoritative stream catches up.
    if (previous) state.approvals = state.approvals.map(incoming => {
      const known = previous.approvals.find(item => item.id === incoming.id);
      return known && (known.version > incoming.version ||
        (known.version === incoming.version && Date.parse(known.updatedAt) > Date.parse(incoming.updatedAt))) ? known : incoming;
    });
    const next = { principal: key, state };
    valueRef.current = next; setValue(next); setError(''); setConfigurationRequired(false); setLoading(false);
    return true;
  }, []);

  const applyApproval = useCallback((payload: TerminalApproval, revision?: number) => {
    const key = principalRef.current;
    const previous = valueRef.current;
    if (!key || readyPrincipal.current !== key || previous?.principal !== key) return false;
    const approval = parseTerminalApproval(payload);
    const latest = previous.state.approvals.filter(item => item.cardId === approval.cardId).sort((a, b) => b.version - a.version)[0];
    if (latest && (latest.version > approval.version ||
      (latest.id === approval.id && Date.parse(latest.updatedAt) > Date.parse(approval.updatedAt)))) return false;
    const active = ['waiting', 'id_requested'].includes(approval.status);
    const next = { principal: key, state: { ...previous.state,
      revision: Math.max(previous.state.revision, revision ?? approval.revision ?? previous.state.revision),
      approvals: [...previous.state.approvals.filter(item => item.id !== approval.id), approval],
      terminals: previous.state.terminals.map(terminal => terminal.id !== approval.terminalId ? terminal : {
        ...terminal, ...(active ? { busy: true, activeApprovalId: approval.id } :
          terminal.activeApprovalId === approval.id ? { busy: false, activeApprovalId: undefined } : {}),
      }),
    } };
    ++requestSerial.current; valueRef.current = next; setValue(next);
    return true;
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const key = principalRef.current, expectedGeneration = generation.current;
    if (!key || readyPrincipal.current !== key) return Promise.resolve();
    if (flight.current?.principal === key && flight.current.generation === expectedGeneration) return flight.current.promise;
    const serial = ++requestSerial.current, controller = new AbortController();
    const pending = { principal: key, generation: expectedGeneration, controller, promise: Promise.resolve() };
    pending.promise = (async () => {
      try {
        const state = await terminalDemoApi.state(controller.signal);
        if (serial === requestSerial.current) acceptState(state, key, expectedGeneration);
      } catch (failure) {
        if (controller.signal.aborted || principalRef.current !== key || expectedGeneration !== generation.current || serial !== requestSerial.current) return;
        if (failure instanceof TerminalDemoError && (failure.status === 401 || failure.status === 403)) { valueRef.current = undefined; setValue(undefined); }
        setError(failure instanceof Error ? failure.message : 'Terminaltjänsten kunde inte nås.');
        setConfigurationRequired(failure instanceof TerminalDemoError && failure.status === 503); setLoading(false);
      } finally { if (flight.current === pending) flight.current = undefined; }
    })();
    flight.current = pending;
    return pending.promise;
  }, [acceptState]);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    readyPrincipal.current = ''; ++requestSerial.current;
    flight.current?.controller.abort(); flight.current = undefined;
    valueRef.current = undefined; setValue(undefined); setError(''); setConfigurationRequired(false); setLoading(Boolean(principal));
    let events: EventSource | undefined, polling: ReturnType<typeof setInterval> | undefined;
    let lastEventAt = 0;
    if (!principal || !actualUser || !user) return;
    staffSessionQueue = staffSessionQueue.catch(() => undefined).then(async () => {
      if (generation.current !== currentGeneration) return;
      try {
        await terminalDemoApi.staffSession(actualUser.id, user.id);
        if (generation.current !== currentGeneration || principalRef.current !== principal) return;
        readyPrincipal.current = principal;
        await refresh();
        if (generation.current !== currentGeneration) return;
        events = new EventSource('/api/terminal-demo/events', { withCredentials: true });
        const receive = (event: MessageEvent<string>) => {
          if (generation.current !== currentGeneration) return;
          try {
            const payload = parseTerminalDemoState(JSON.parse(event.data));
            if (payload.actualUserId !== actualUser.id || payload.effectiveUserId !== user.id) return;
            if (acceptState(payload, principal, currentGeneration)) {
              lastEventAt = Date.now(); ++requestSerial.current; notifyBusinessConnection(principal, true);
            }
          } catch { void refresh(); }
        };
        events.onmessage = receive; events.addEventListener('state', receive);
        events.addEventListener('heartbeat', (event: MessageEvent<string>) => {
          if (generation.current !== currentGeneration) return;
          try {
            const payload = JSON.parse(event.data);
            if (payload.actualUserId === actualUser.id && payload.effectiveUserId === user.id) {
              lastEventAt = Date.now(); notifyBusinessConnection(principal, true);
            }
          } catch { /* No healthy signal is accepted from a malformed heartbeat. */ }
        });
        events.addEventListener('change', (event: MessageEvent<string>) => {
          if (generation.current !== currentGeneration) return;
          try {
            const payload = JSON.parse(event.data);
            if (payload.actualUserId !== actualUser.id || payload.effectiveUserId !== user.id ||
                !['application', 'environment', 'terminal', 'terminal-presence'].includes(payload.domain) ||
                !Number.isSafeInteger(payload.revision) || payload.revision < 0 || typeof payload.eventId !== 'string') return;
            lastEventAt = Date.now();
            notifyBusinessChange({ identity: principal, domain: payload.domain, revision: payload.revision, eventId: payload.eventId });
          } catch { /* Invalid invalidations cannot trigger privileged reads. */ }
        });
        events.addEventListener('session-ended', () => { events?.close(); lastEventAt = 0; notifyBusinessConnection(principal, false); void refresh(); });
        events.onerror = () => { lastEventAt = 0; notifyBusinessConnection(principal, false); };
        // Reconnect delivers a new scoped baseline. Only reconcile when the stream
        // is absent or no authenticated heartbeat has arrived for 45 seconds.
        polling = setInterval(() => {
          if (document.visibilityState === 'visible' && (!events || events.readyState !== EventSource.OPEN || Date.now() - lastEventAt > 45_000)) void refresh();
        }, 30_000);
      } catch (failure) {
        if (generation.current !== currentGeneration) return;
        setError(failure instanceof Error ? failure.message : 'Terminaltjänsten kunde inte nås.');
        setConfigurationRequired(failure instanceof TerminalDemoError && failure.status === 503); setLoading(false);
      }
    });
    return () => {
      notifyBusinessConnection(principal, false);
      ++generation.current; readyPrincipal.current = ''; events?.close(); clearInterval(polling);
      flight.current?.controller.abort(); flight.current = undefined;
    };
  }, [principal, permissions, actualUser?.id, user?.id, refresh, acceptState]);

  const state = value?.principal === principal ? value.state : undefined;
  return { state, loading, error, configurationRequired, connected: Boolean(state), refresh, applyApproval };
}
