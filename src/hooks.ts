import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { observeAuth, subscribeCooldownTimers, subscribeDonationRecord, subscribeSettings, subscribeSosForDay, subscribeWasteForDay } from './data';
import { DEFAULT_DONATION_ITEMS } from './defaults';
import { dayKey, previousDayKey } from './domain';
import type { AppSettings, CooldownTimer, DonationRecord, MemberProfile, SosEntry, WasteEvent } from './types';

export function useAuthUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let unsubscribe: () => void = () => undefined;
    try {
      unsubscribe = observeAuth((nextUser) => {
        setUser(nextUser);
        setLoading(false);
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Firebase could not start.');
      setLoading(false);
    }
    return unsubscribe;
  }, []);

  return { user, loading, error };
}

export function useMember(user: User | null) {
  const member = useMemo<MemberProfile | null>(() => user ? ({
    uid: user.uid,
    storeId: import.meta.env.VITE_STORE_ID || '00756',
    displayName: 'Store team',
    role: 'admin',
  }) : null, [user]);
  return { member, loading: false, error: '' };
}

export function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function useDeviceName() {
  return useMemo(() => {
    const stored = localStorage.getItem('waste-sos-device-name');
    if (stored) return stored;
    const detected = /iPad/.test(navigator.userAgent)
      ? 'iPad'
      : /iPhone/.test(navigator.userAgent)
        ? 'iPhone'
        : 'Web device';
    localStorage.setItem('waste-sos-device-name', detected);
    return detected;
  }, []);
}

export function useStoreData(storeId: string | undefined, now: Date) {
  const today = dayKey(now);
  const previous = previousDayKey(now);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [todayWaste, setTodayWaste] = useState<WasteEvent[]>([]);
  const [previousWaste, setPreviousWaste] = useState<WasteEvent[]>([]);
  const [sosEntries, setSosEntries] = useState<SosEntry[]>([]);
  const [donationRecord, setDonationRecord] = useState<DonationRecord | null>(null);
  const [cooldownTimers, setCooldownTimers] = useState<CooldownTimer[]>([]);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(Boolean(storeId));

  useEffect(() => {
    if (!storeId) return;
    setError('');
    setReady(true);
    const handleError = (caught: { message: string }) => {
      setError(caught.message);
      setReady(true);
    };
    const subscriptions = [
      subscribeSettings(storeId, (value) => {
        setSettings(value ? {
          ...value,
          cooldownTimersEnabled: value.cooldownTimersEnabled ?? false,
          products: value.products.map((product) => product.id === 'nuggets'
            ? { ...product, menus: ['breakfast', 'lunch'] }
            : product),
          donationItems: DEFAULT_DONATION_ITEMS.map((defaultItem) => (
            value.donationItems.find((item) => item.id === defaultItem.id) || defaultItem
          )),
        } : value);
      }, handleError),
      subscribeWasteForDay(storeId, today, setTodayWaste, handleError),
      subscribeWasteForDay(storeId, previous, setPreviousWaste, handleError),
      subscribeSosForDay(storeId, today, setSosEntries, handleError),
      subscribeDonationRecord(storeId, today, setDonationRecord, handleError),
      subscribeCooldownTimers(storeId, setCooldownTimers, handleError),
    ];
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [storeId, today, previous]);

  return { settings, todayWaste, previousWaste, sosEntries, donationRecord, cooldownTimers, error, ready, today };
}
