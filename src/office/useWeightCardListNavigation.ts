import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

type ListPosition = {
  route: string;
  scope: string;
  search: string;
  siteId: string;
  scrollY: number;
};
type NavigationState = { weightCardReturn?: ListPosition; restoreWeightCardList?: ListPosition };
const listRoute = /^\/(?:(?:dashboard|weighings|customer-approvals|attest|payments)|customers\/[^/?#]+)(?:\?.*)?$/;
const labels: Record<string, string> = {
  dashboard: 'Till översikten', weighings: 'Till invägningar',
  'customer-approvals': 'Till kundgodkännanden', attest: 'Till attest', payments: 'Till utbetalningar',
  customers: 'Till kunden',
};

/** Keep the originating queue, filters and scroll together, scoped to the
 * authenticated company/person. Both the back button and browser Back restore
 * the list; a direct/new-tab card link still has a normal queue fallback. */
export function useWeightCardListNavigation({ scope, search, setSearch, siteId, setSiteId, ready }: {
  scope: string;
  search: string;
  setSearch: (value: string) => void;
  siteId: string;
  setSiteId: (value: string) => void;
  ready: boolean;
}) {
  const location = useLocation(), navigate = useNavigate(), navigationType = useNavigationType();
  const positions = useRef(new Map<string, ListPosition>());
  const currentScope = useRef(scope);
  const applied = useRef('');
  if (currentScope.current !== scope) {
    currentScope.current = scope;
    positions.current.clear();
    applied.current = '';
  }
  const state = location.state as NavigationState | null;
  const valid = (value?: ListPosition) => value?.scope === scope && listRoute.test(value.route) ? value : undefined;
  const returnPosition = valid(state?.weightCardReturn);

  useLayoutEffect(() => {
    if (!ready || applied.current === location.key) return;
    const position = valid(state?.restoreWeightCardList)
      ?? (navigationType === 'POP' ? valid(positions.current.get(location.key)) : undefined);
    let frame = 0;
    if (listRoute.test(location.pathname + location.search) && position) {
      setSearch(position.search);
      setSiteId(position.siteId);
      // React first renders the restored filter, then the browser measures the
      // actual list height. Do not smooth-scroll through hundreds of rows.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          window.scrollTo({ top: position.scrollY, behavior: 'instant' });
          applied.current = location.key;
        });
      });
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' });
      applied.current = location.key;
    }
    return () => cancelAnimationFrame(frame);
  }, [scope, location.key, ready]);

  return {
    open(route: string) {
      let position = returnPosition;
      const currentRoute = location.pathname + location.search;
      if (listRoute.test(currentRoute)) {
        position = { route: currentRoute, scope, search, siteId, scrollY: window.scrollY };
        positions.current.set(location.key, position);
        if (positions.current.size > 40) positions.current.delete(positions.current.keys().next().value!);
      }
      navigate(route, { state: position ? { weightCardReturn: position } : null });
    },
    back(fallback: string) {
      navigate(returnPosition?.route ?? fallback, {
        state: returnPosition ? { restoreWeightCardList: returnPosition } : null,
      });
    },
    backLabel(fallback: string) {
      return returnPosition ? labels[returnPosition.route.split(/[/?]/)[1]] ?? fallback : fallback;
    },
  };
}
