import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { observeAuth, subscribeCooldownTimers, subscribeDiscardForDay, subscribeDonationRecord, subscribeSettings, subscribeSosForDay, subscribeWasteForDay } from './data';
import { DEFAULT_DONATION_ITEMS, DEFAULT_PRODUCTS, PRODUCT_TONES } from './defaults';
import { dayKey, donationWindowDayKeys, withDerivedProductPricing } from './domain';
import type { AppSettings, CooldownTimer, DiscardEvent, DonationRecord, MemberProfile, SosEntry, WasteEvent } from './types';

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

export function useDonationDayData(storeId: string, selectedDayKey: string) {
  const windowDays = donationWindowDayKeys(selectedDayKey);
  const [currentWaste, setCurrentWaste] = useState<WasteEvent[]>([]);
  const [previousWaste, setPreviousWaste] = useState<WasteEvent[]>([]);
  const [record, setRecord] = useState<DonationRecord | null>(null);
  const [loadedDayKey, setLoadedDayKey] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let currentReady = false;
    let previousReady = false;
    let recordReady = false;
    const markReady = () => {
      if (!disposed && currentReady && previousReady && recordReady) {
        setLoadedDayKey(selectedDayKey);
      }
    };
    const handleError = (caught: { message: string }) => {
      if (disposed) return;
      setError(caught.message);
      setLoadedDayKey(selectedDayKey);
    };

    setError('');
    setCurrentWaste([]);
    setPreviousWaste([]);
    setRecord(null);

    const subscriptions = [
      subscribeWasteForDay(storeId, windowDays.current, (events) => {
        if (disposed) return;
        setCurrentWaste(events);
        currentReady = true;
        markReady();
      }, handleError),
      subscribeWasteForDay(storeId, windowDays.previous, (events) => {
        if (disposed) return;
        setPreviousWaste(events);
        previousReady = true;
        markReady();
      }, handleError),
      subscribeDonationRecord(storeId, windowDays.current, (nextRecord) => {
        if (disposed) return;
        setRecord(nextRecord);
        recordReady = true;
        markReady();
      }, handleError),
    ];

    return () => {
      disposed = true;
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, [storeId, selectedDayKey, windowDays.current, windowDays.previous]);

  return {
    currentWaste,
    previousWaste,
    record,
    error,
    loading: loadedDayKey !== selectedDayKey,
    previousDayKey: windowDays.previous,
  };
}

export function useStoreData(storeId: string | undefined, now: Date) {
  const today = dayKey(now);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [todayWaste, setTodayWaste] = useState<WasteEvent[]>([]);
  const [discardEvents, setDiscardEvents] = useState<DiscardEvent[]>([]);
  const [sosEntries, setSosEntries] = useState<SosEntry[]>([]);
  const [cooldownTimers, setCooldownTimers] = useState<CooldownTimer[]>([]);
  const [cooldownTimersSynced, setCooldownTimersSynced] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(Boolean(storeId));

  useEffect(() => {
    if (!storeId) return;
    setError('');
    setReady(true);
    setCooldownTimersSynced(false);
    const handleError = (caught: { message: string }) => {
      setError(caught.message);
      setReady(true);
    };
    const subscriptions = [
      subscribeSettings(storeId, (value) => {
        setSettings(value ? {
          ...value,
          cooldownTimersEnabled: value.cooldownTimersEnabled ?? false,
          sosEnabled: value.sosEnabled ?? true,
          discardTrackingEnabled: value.discardTrackingEnabled ?? false,
          cardScrubEnabled: value.cardScrubEnabled ?? true,
          alarmVoiceVolume: value.alarmVoiceVolume ?? 1,
          products: [
            ...DEFAULT_PRODUCTS.map((defaultProduct) => (
              value.products.find((product) => product.id === defaultProduct.id) || defaultProduct
            )),
            ...value.products.filter((product) => (
              !DEFAULT_PRODUCTS.some((defaultProduct) => defaultProduct.id === product.id)
            )),
          ].map((product) => {
            const normalized = product.id === 'nuggets'
              ? { ...product, menus: ['breakfast', 'lunch'] as typeof product.menus }
              : product;
            return withDerivedProductPricing({
              ...normalized,
              perUnitWeight: normalized.perUnitWeight ?? normalized.averageWeightLb,
              perUnitWeightUnit: normalized.perUnitWeightUnit ?? 'lb',
              tone: PRODUCT_TONES[product.id] ?? product.tone,
            });
          }),
          donationItems: DEFAULT_DONATION_ITEMS.map((defaultItem) => (
            value.donationItems.find((item) => item.id === defaultItem.id) || defaultItem
          )),
        } : value);
      }, handleError),
      subscribeWasteForDay(storeId, today, setTodayWaste, handleError),
      subscribeSosForDay(storeId, today, setSosEntries, handleError),
      subscribeCooldownTimers(storeId, (timers, serverConfirmed) => {
        setCooldownTimers(timers);
        if (serverConfirmed) setCooldownTimersSynced(true);
      }, handleError),
    ];
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [storeId, today]);

  useEffect(() => {
    if (!storeId) {
      setDiscardEvents([]);
      return;
    }
    return subscribeDiscardForDay(storeId, today, setDiscardEvents, (caught) => {
      setError(caught.message);
      setReady(true);
    });
  }, [storeId, today]);

  return { settings, todayWaste, discardEvents, sosEntries, cooldownTimers, cooldownTimersSynced, error, ready, today };
}
