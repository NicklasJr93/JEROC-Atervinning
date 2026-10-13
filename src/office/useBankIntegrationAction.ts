import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficeUser } from './model';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { integrationReadScope } from './integration-read-cache';
import { mayManageBank } from './bank-integration-client';
import { EnvironmentApiError } from './environment-client';

/** Abort and hide every response as soon as company, session or permissions change. */
export function useBankIntegrationAction(user: OfficeUser, actualUser: OfficeUser) {
  const context = useEnvironmentSession();
  const matching = context.session?.actualUserId === actualUser.id && context.session?.effectiveUserId === user.id;
  const permitted = mayManageBank(user, actualUser);
  const scope = integrationReadScope(actualUser, user, context.session);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const allowedRef = useRef(false);
  const mounted = useRef(true), generation = useRef(0);
  const foreground = useRef<AbortController | undefined>(undefined), reads = useRef(new Map<string, AbortController>());
  const [activity, setActivity] = useState<{ scope: string; pending?: string; error?: string; reads?: string[]; authFailed?: boolean }>();
  const pending = activity?.scope === scope ? activity.pending : undefined;
  const error = activity?.scope === scope ? activity.error ?? '' : '';
  const authFailed = activity?.scope === scope && !!activity.authFailed;
  allowedRef.current = permitted && matching && !!scope && !authFailed;
  const pendingReads = activity?.scope === scope ? activity.reads ?? [] : [];
  const update = (patch: Partial<NonNullable<typeof activity>>) => setActivity(previous => ({ ...(previous?.scope === scope ? previous : {}), scope, ...patch }));
  const cancel = () => { foreground.current?.abort(); foreground.current = undefined; for (const controller of reads.current.values()) controller.abort(); reads.current.clear(); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; cancel(); }; }, []);
  useEffect(() => { generation.current++; cancel(); setActivity({ scope }); }, [scope, permitted, matching]);
  const run = useCallback(async (kind: string, operation: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (!allowedRef.current || foreground.current) return;
    const controller = new AbortController(); foreground.current = controller;
    const version = generation.current;
    const current = () => mounted.current && !controller.signal.aborted && scopeRef.current === scope && allowedRef.current && generation.current === version && foreground.current === controller;
    update({ pending: kind, error: '' });
    try { await operation(controller.signal, current); }
    catch (failure) { if (current()) update({ error: environmentFailure(failure), authFailed: failure instanceof EnvironmentApiError && [401, 403].includes(failure.status) }); }
    finally { if (foreground.current === controller) { if (current()) update({ pending: undefined }); foreground.current = undefined; } }
  }, [scope]);
  // Only independent reference data uses this lane. Consent/account reads and
  // settings writes stay ordered in run(); a bank list cannot lock that lane.
  const runRead = useCallback(async (kind: string, operation: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (!allowedRef.current || reads.current.has(kind)) return;
    const controller = new AbortController(), version = generation.current;
    reads.current.set(kind, controller); update({ reads: [...reads.current.keys()], error: '' });
    const current = () => mounted.current && !controller.signal.aborted && scopeRef.current === scope && allowedRef.current && generation.current === version && reads.current.get(kind) === controller;
    try { await operation(controller.signal, current); }
    catch (failure) { if (current()) update({ error: environmentFailure(failure), authFailed: failure instanceof EnvironmentApiError && [401, 403].includes(failure.status) }); }
    finally { if (reads.current.get(kind) === controller) { const visible = current(); reads.current.delete(kind); if (visible) update({ reads: [...reads.current.keys()] }); } }
  }, [scope]);
  const refreshSession = useCallback(async () => {
    await context.refreshSession();
    if (mounted.current && scopeRef.current === scope) update({ error: '', authFailed: false });
  }, [context.refreshSession, scope]);
  return { ...context, refreshSession, sessionError: authFailed ? error : context.error, scope, matching: matching && !authFailed, permitted, pending, pendingReads, error, run, runRead };
}
