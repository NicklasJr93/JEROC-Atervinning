import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficeUser } from './model';
import { TerminalDemoError, terminalDemoApi } from './terminal-demo-client';
import type { TerminalDemoState } from './terminal-demo-types';

// Cookie changes must finish in order, including when "Jobba som" changes quickly.
let staffSessionQueue: Promise<unknown> = Promise.resolve();

export function useTerminalDemo(actualUser: OfficeUser | undefined, user: OfficeUser | undefined) {
  const principal = actualUser && user ? `${actualUser.id}/${user.id}` : '';
  const principalRef = useRef(principal);
  principalRef.current = principal;
  const generation = useRef(0);
  const requestSerial = useRef(0);
  const readyPrincipal = useRef('');
  const [value, setValue] = useState<{ principal: string; state: TerminalDemoState }>();
  const [loading, setLoading] = useState(Boolean(principal));
  const [error, setError] = useState('');
  const [configurationRequired, setConfigurationRequired] = useState(false);

  const refresh = useCallback(async () => {
    const key = principalRef.current;
    if (!key || readyPrincipal.current !== key) return;
    const serial = ++requestSerial.current;
    try {
      const state = await terminalDemoApi.state();
      if (principalRef.current === key && readyPrincipal.current === key && serial === requestSerial.current) {
        setValue({ principal: key, state });
        setError('');
        setConfigurationRequired(false);
        setLoading(false);
      }
    } catch (failure) {
      if (principalRef.current === key && serial === requestSerial.current) {
        if (failure instanceof TerminalDemoError && (failure.status === 401 || failure.status === 403)) setValue(undefined);
        setError(failure instanceof Error ? failure.message : 'Terminaltjänsten kunde inte nås.');
        setConfigurationRequired(failure instanceof TerminalDemoError && failure.status === 503);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    readyPrincipal.current = '';
    ++requestSerial.current;
    setValue(undefined);
    setError('');
    setConfigurationRequired(false);
    setLoading(Boolean(principal));
    let events: EventSource | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    if (!principal || !actualUser || !user) return;

    staffSessionQueue = staffSessionQueue.catch(() => undefined).then(async () => {
      if (generation.current !== currentGeneration) return;
      try {
        await terminalDemoApi.staffSession(actualUser.id, user.id);
        if (generation.current !== currentGeneration || principalRef.current !== principal) return;
        readyPrincipal.current = principal;
        await refresh();
        if (generation.current !== currentGeneration) return;
        const scheduleRefresh = () => {
          if (generation.current !== currentGeneration) return;
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => { void refresh(); }, 80);
        };
        events = new EventSource('/api/terminal-demo/events', { withCredentials: true });
        events.onmessage = scheduleRefresh;
        events.addEventListener('state', scheduleRefresh);
        events.addEventListener('change', scheduleRefresh);
        events.addEventListener('session-ended', () => { events?.close(); void refresh(); });
        events.onopen = scheduleRefresh;
        // Polling also keeps online/offline indicators current if no state changed.
        polling = setInterval(() => { void refresh(); }, 15000);
      } catch (failure) {
        if (generation.current !== currentGeneration) return;
        setError(failure instanceof Error ? failure.message : 'Terminaltjänsten kunde inte nås.');
        setConfigurationRequired(failure instanceof TerminalDemoError && failure.status === 503);
        setLoading(false);
      }
    });
    return () => {
      ++generation.current;
      readyPrincipal.current = '';
      events?.close();
      clearTimeout(refreshTimer);
      clearInterval(polling);
    };
  }, [principal, actualUser?.id, user?.id, refresh]);

  const state = value?.principal === principal ? value.state : undefined;
  return { state, loading, error, configurationRequired, connected: Boolean(state), refresh };
}
