import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { applyPersonLookupToCustomer, normalizePersonLookupNumber, type PersonRegisterPerson } from './client';

export interface PersonLookupCustomerFields { number: string; name: string; address?: string; postalCode?: string; city?: string; countryCode?: string }
type Field = 'name' | 'address' | 'postalCode' | 'city' | 'countryCode';
const addressFields = ['address', 'postalCode', 'city'] as const;

/** Remember only fields this lookup actually filled. Changing identity clears
 * unchanged automatic values, while a manual address edit protects the unit. */
export function usePersonLookupAutofill<T extends PersonLookupCustomerFields>(customer: T, setCustomer: Dispatch<SetStateAction<T>>, contextKey: string) {
  const identity = JSON.stringify([contextKey, normalizePersonLookupNumber(customer.number)]);
  const previousIdentity = useRef(identity), automatic = useRef<Partial<Record<Field, string>>>({});
  const countryBefore = useRef<string | undefined>(undefined);
  const latest = useRef({ identity, setCustomer }); latest.current = { identity, setCustomer };
  useLayoutEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    const values = automatic.current, originalCountry = countryBefore.current; automatic.current = {}; countryBefore.current = undefined;
    if (!Object.keys(values).length) return;
    setCustomer(current => {
      if (JSON.stringify([contextKey, normalizePersonLookupNumber(current.number)]) !== identity) return current;
      const next = { ...current };
      if (values.name !== undefined && current.name === values.name) next.name = '';
      if (addressFields.every(field => values[field] !== undefined && (current[field] ?? '') === values[field])
        && (values.countryCode === undefined || current.countryCode === values.countryCode)) {
        for (const field of addressFields) next[field] = '';
        if (values.countryCode !== undefined) next.countryCode = originalCountry;
      }
      return next;
    });
  }, [identity, contextKey, setCustomer]);
  const touch = useCallback((field: string) => {
    if (field === 'name') delete automatic.current.name;
    if (field === 'countryCode' || addressFields.includes(field as typeof addressFields[number])) {
      for (const item of addressFields) delete automatic.current[item];
      delete automatic.current.countryCode; countryBefore.current = undefined;
    }
  }, []);
  const apply = useCallback((person: PersonRegisterPerson) => {
    const expected = latest.current.identity;
    latest.current.setCustomer(current => {
      if (latest.current.identity !== expected || normalizePersonLookupNumber(current.number) !== person.personalNumber) return current;
      const next = applyPersonLookupToCustomer(current, person);
      if (next.name !== current.name) automatic.current.name = next.name;
      if (addressFields.some(field => next[field] !== current[field]) || next.countryCode !== current.countryCode) {
        for (const field of addressFields) automatic.current[field] = next[field] ?? '';
        if ('countryCode' in current) { automatic.current.countryCode = next.countryCode ?? ''; countryBefore.current = current.countryCode; }
      }
      return next;
    });
  }, []);
  return { apply, touch };
}
