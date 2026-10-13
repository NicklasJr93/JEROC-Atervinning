import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { can, type OfficeCard, type OfficeUser } from './model';
import { useEnvironmentSession } from './EnvironmentSession';
import { spirisBookingApi, type SpirisCardBooking } from './booking-client';
import type { SwishPaymentJob } from './swish-payments-client';
import type { BankPaymentJob } from './bank-payments-client';

interface BookingContext {
  booking?: SpirisCardBooking;
  loading: boolean;
  error: string;
  permitted: boolean;
  canBook: boolean;
  canPay: boolean;
  hasPayment: boolean;
  reportPayment: (payment: SwishPaymentJob | undefined) => void;
  reportBankPayment: (payment: BankPaymentJob | undefined) => void;
  book: () => Promise<void>;
  refresh: () => Promise<void>;
}
const Context = createContext<BookingContext | null>(null);
export function useCardBooking() {
  const value = useContext(Context);
  if (!value) throw new Error('Utbetalningskortet behöver CardBookingProvider.');
  return value;
}
export function CardBookingProvider({ card, user, actualUser, children }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; children: ReactNode;
}) {
  const { session } = useEnvironmentSession();
  const [booking, setBooking] = useState<SpirisCardBooking>(), [payment, setPayment] = useState<SwishPaymentJob>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [bankPayment, setBankPayment] = useState<BankPaymentJob>();
  const identity = `${actualUser.id}/${user.id}`;
  const matches = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const readAllowed = (can(user, 'pay') && can(actualUser, 'pay')) || (can(user, 'attest') && can(actualUser, 'attest')) || (can(user, 'bookSpiris') && can(actualUser, 'bookSpiris'));
  const allowed = Boolean(matches && readAllowed), eligible = ['ready', 'paid', 'balance'].includes(card.status);
  const epoch = useRef(0), flight = useRef<AbortController | null>(null);
  const reportPayment = useCallback((value: SwishPaymentJob | undefined) => setPayment(value), []);
  const reportBankPayment = useCallback((value: BankPaymentJob | undefined) => setBankPayment(value), []);
  const load = useCallback(async (action: 'read' | 'refresh' | 'book' = 'read') => {
    if (!allowed || !eligible || flight.current) return;
    const expected = epoch.current, controller = new AbortController(); flight.current = controller;
    setLoading(true);
    try {
      const next = await spirisBookingApi[action](card.id, controller.signal);
      if (!controller.signal.aborted && expected === epoch.current) { setBooking(next); setError(''); }
    } catch (failure) {
      if (!controller.signal.aborted && expected === epoch.current) setError(failure instanceof Error ? failure.message : 'Spiris-statusen kunde inte hämtas.');
    } finally {
      if (flight.current === controller) flight.current = null;
      if (expected === epoch.current) setLoading(false);
    }
  }, [card.id, identity, eligible, allowed]);
  useEffect(() => {
    epoch.current += 1; flight.current?.abort(); flight.current = null; setBooking(undefined); setPayment(undefined); setBankPayment(undefined); setLoading(false); setError('');
    void load();
    return () => { epoch.current += 1; flight.current?.abort(); flight.current = null; };
  }, [load]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ cardId: number; identity: string }>).detail;
      if (detail?.cardId === card.id && detail.identity === identity) void load();
    };
    window.addEventListener('scrappilot:booking-change', changed);
    return () => window.removeEventListener('scrappilot:booking-change', changed);
  }, [card.id, identity, load]);
  useEffect(() => {
    if (!allowed || !eligible || !booking || !['creating_draft', 'draft', 'booking', 'unknown'].includes(booking.status)) return;
    const started = Date.now(), timer = window.setInterval(() => {
      if (Date.now() - started > 90_000) { window.clearInterval(timer); return; }
      if (document.visibilityState === 'visible') void load();
    }, ['creating_draft', 'booking'].includes(booking.status) ? 3000 : 15_000);
    return () => window.clearInterval(timer);
  }, [allowed, eligible, booking?.status, load]);
  const canBook = Boolean(allowed && booking?.canBook && can(user, 'bookSpiris') && can(actualUser, 'bookSpiris'));
  const canPay = Boolean(allowed && card.status === 'ready' && !payment && !bankPayment && booking?.status === 'booked' && !card.financialPending && can(user, 'pay') && can(actualUser, 'pay'));
  return <Context.Provider value={{ booking, loading, error, permitted: readAllowed, canBook, canPay, hasPayment: Boolean(payment || bankPayment), reportPayment, reportBankPayment,
    book: () => canBook ? load('book') : Promise.resolve(), refresh: () => load('refresh') }}>{children}</Context.Provider>;
}
export function CardBookingPayButton({ onStart, disabled = false }: { onStart: () => void; disabled?: boolean }) {
  const { canPay, hasPayment, booking, loading } = useCardBooking();
  return <button className="office-btn" disabled={disabled || (!canPay && !hasPayment) || loading} onClick={onStart}
    title={canPay || hasPayment ? undefined : booking?.reason ?? 'Bokför underlaget i Spiris före utbetalning.'}>{hasPayment ? 'Visa utbetalning' : 'Betala ut'}</button>;
}
