import { useCallback, useEffect, useRef, useState } from 'react';
import type { OfficeUser } from './model';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { integrationReadScope } from './integration-read-cache';
import { mayManageBank } from './bank-integration-client';

/** Abort and hide every response as soon as company, session or permissions change. */
export function useBankIntegrationAction(user: OfficeUser, actualUser: OfficeUser) {
  const context = useEnvironmentSession();
  const matching = context.session?.actualUserId === actualUser.id && context.session?.effectiveUserId === user.id;
  const permitted = mayManageBank(user, actualUser);
  const scope = integrationReadScope(actualUser, user, context.session);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const allowedRef = useRef(false); allowedRef.current = permitted && matching && !!scope;
  const mounted = useRef(true), generation = useRef(0), busy = useRef(false), controllers = useRef(new Set<AbortController>());
  const [activity, setActivity] = useState<{ scope: string; pending?: string; error?: string }>();
  const pending = activity?.scope === scope ? activity.pending : undefined;
  const error = activity?.scope === scope ? activity.error ?? '' : '';
  const setPending = (kind?: string) => setActivity(previous => ({ scope, error: previous?.scope === scope ? previous.error : undefined, pending: kind }));
  const setError = (message: string) => setActivity(previous => ({ scope, pending: previous?.scope === scope ? previous.pending : undefined, error: message }));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; for (const controller of controllers.current) controller.abort(); }; }, []);
  useEffect(() => { generation.current++; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); busy.current = false; setPending(undefined); setError(''); }, [scope, permitted, matching]);
  const run = useCallback(async (kind: string, operation: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    if (!allowedRef.current || busy.current) return;
    const controller = new AbortController(); controllers.current.add(controller);
    const version = ++generation.current;
    const current = () => mounted.current && !controller.signal.aborted && scopeRef.current === scope && allowedRef.current && generation.current === version;
    busy.current = true; setPending(kind); setError('');
    try { await operation(controller.signal, current); }
    catch (failure) { if (current()) setError(environmentFailure(failure)); }
    finally { controllers.current.delete(controller); if (current()) { busy.current = false; setPending(undefined); } }
  }, [scope]);
  return { ...context, scope, matching, permitted, pending, error, run };
}
