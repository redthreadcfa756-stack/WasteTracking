import { useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { ensureDailyWasteSummaries, observeAuth, subscribeCooldownTimers, subscribeDailyWasteSummaries, subscribeDiscardForDay, subscribeDonationRecord, subscribeDonationRecordsForDateRange, subscribeSettings, subscribeSosForDay, subscribeUsageDay, subscribeUsageDaysForDateRange, subscribeWasteForDateRange, subscribeWasteForDay } from './data';
import { DEFAULT_DONATION_ITEMS, DEFAULT_PRODUCTS, PRODUCT_TONES } from './defaults';
import { dayKey, donationWindowDayKeys, nextOperatingDayKey, withDerivedProductPricing } from './domain';
import type { AppSettings, CooldownTimer, DailyWasteSummary, DiscardEvent, DonationRecord, MemberProfile, SosEntry, UsageDayRecord, WasteEvent } from './types';

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

export function useUsageData(storeId: string, selectedDayKey: string) {
  const donationDay = nextOperatingDayKey(selectedDayKey);
  const [record, setRecord] = useState<UsageDayRecord | null>(null);
  const [currentWaste, setCurrentWaste] = useState<WasteEvent[]>([]);
  const [donationDayWaste, setDonationDayWaste] = useState<WasteEvent[]>([]);
  const [donationRecord, setDonationRecord] = useState<DonationRecord | null>(null);
  const [readyParts, setReadyParts] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let usageReady = false;
    let currentWasteReady = false;
    let donationDayWasteReady = false;
    let donationReady = false;
    const markReady = () => {
      if (!disposed && usageReady && currentWasteReady && donationDayWasteReady && donationReady) setReadyParts(4);
    };
    const handleError = (caught: { message: string }) => {
      if (!disposed) {
        setError(caught.message);
        setReadyParts(4);
      }
    };

    setRecord(null);
    setCurrentWaste([]);
    setDonationDayWaste([]);
    setDonationRecord(null);
    setReadyParts(0);
    setError('');

    const subscriptions = [
      subscribeUsageDay(storeId, selectedDayKey, (nextRecord) => {
        if (disposed) return;
        setRecord(nextRecord);
        usageReady = true;
        markReady();
      }, handleError),
      subscribeWasteForDay(storeId, selectedDayKey, (events) => {
        if (disposed) return;
        setCurrentWaste(events);
        currentWasteReady = true;
        markReady();
      }, handleError),
      subscribeWasteForDay(storeId, donationDay, (events) => {
        if (disposed) return;
        setDonationDayWaste(events);
        donationDayWasteReady = true;
        markReady();
      }, handleError),
      subscribeDonationRecord(storeId, donationDay, (nextRecord) => {
        if (disposed) return;
        setDonationRecord(nextRecord);
        donationReady = true;
        markReady();
      }, handleError),
    ];

    return () => {
      disposed = true;
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, [donationDay, selectedDayKey, storeId]);

  return {
    record,
    currentWaste,
    donationDayWaste,
    donationDayKey: donationDay,
    donationRecord,
    loading: readyParts < 4,
    error,
  };
}

export function useUsageRangeData(storeId: string, startDayKey: string, endDayKey: string) {
  const extendedEndDayKey = nextOperatingDayKey(endDayKey);
  const [wasteEvents, setWasteEvents] = useState<WasteEvent[]>([]);
  const [donationRecords, setDonationRecords] = useState<DonationRecord[]>([]);
  const [usageRecords, setUsageRecords] = useState<UsageDayRecord[]>([]);
  const [readyParts, setReadyParts] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!startDayKey || !endDayKey || startDayKey > endDayKey) {
      setWasteEvents([]);
      setDonationRecords([]);
      setUsageRecords([]);
      setReadyParts(3);
      return;
    }

    let disposed = false;
    let wasteReady = false;
    let donationReady = false;
    let usageReady = false;
    const markReady = () => {
      if (!disposed && wasteReady && donationReady && usageReady) setReadyParts(3);
    };
    const handleError = (caught: { message: string }) => {
      if (!disposed) {
        setError(caught.message);
        setReadyParts(3);
      }
    };

    setWasteEvents([]);
    setDonationRecords([]);
    setUsageRecords([]);
    setReadyParts(0);
    setError('');

    const subscriptions = [
      subscribeWasteForDateRange(storeId, startDayKey, extendedEndDayKey, (events) => {
        if (disposed) return;
        setWasteEvents(events);
        wasteReady = true;
        markReady();
      }, handleError),
      subscribeDonationRecordsForDateRange(storeId, startDayKey, extendedEndDayKey, (records) => {
        if (disposed) return;
        setDonationRecords(records);
        donationReady = true;
        markReady();
      }, handleError),
      subscribeUsageDaysForDateRange(storeId, startDayKey, endDayKey, (records) => {
        if (disposed) return;
        setUsageRecords(records);
        usageReady = true;
        markReady();
      }, handleError),
    ];

    return () => {
      disposed = true;
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  }, [endDayKey, extendedEndDayKey, startDayKey, storeId]);

  return {
    wasteEvents,
    donationRecords,
    usageRecords,
    loading: readyParts < 3,
    error,
  };
}

export function useUsageDayRecord(storeId: string, selectedDayKey: string) {
  const [record, setRecord] = useState<UsageDayRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setRecord(null);
    setLoading(true);
    setError('');
    return subscribeUsageDay(storeId, selectedDayKey, (nextRecord) => {
      setRecord(nextRecord);
      setLoading(false);
    }, (caught) => {
      setError(caught.message);
      setLoading(false);
    });
  }, [selectedDayKey, storeId]);

  return { record, loading, error };
}

export function useStoreData(storeId: string | undefined, now: Date) {
  const today = dayKey(now);
  const monthStart = dayKey(new Date(now.getFullYear(), now.getMonth(), 1, 12));
  const completedDate = new Date(now);
  completedDate.setDate(completedDate.getDate() - 1);
  if (completedDate.getDay() === 0) completedDate.setDate(completedDate.getDate() - 1);
  const completedDayCandidate = dayKey(completedDate);
  const monthCompletedThrough = completedDayCandidate >= monthStart ? completedDayCandidate : '';
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [todayWaste, setTodayWaste] = useState<WasteEvent[]>([]);
  const [todayWastePending, setTodayWastePending] = useState(false);
  const [monthToDateSummaries, setMonthToDateSummaries] = useState<DailyWasteSummary[]>([]);
  const [monthToDateDonations, setMonthToDateDonations] = useState<DonationRecord[]>([]);
  const [discardEvents, setDiscardEvents] = useState<DiscardEvent[]>([]);
  const [discardPending, setDiscardPending] = useState(false);
  const [sosEntries, setSosEntries] = useState<SosEntry[]>([]);
  const [cooldownTimers, setCooldownTimers] = useState<CooldownTimer[]>([]);
  const [cooldownTimersSynced, setCooldownTimersSynced] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(Boolean(storeId));

  useEffect(() => {
    if (!storeId) return;
    setError('');
    setReady(true);
    setTodayWastePending(false);
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
      subscribeWasteForDay(storeId, today, (events, hasPendingWrites) => {
        setTodayWaste(events);
        setTodayWastePending(hasPendingWrites);
      }, handleError),
      subscribeSosForDay(storeId, today, setSosEntries, handleError),
      subscribeCooldownTimers(storeId, (timers, serverConfirmed) => {
        setCooldownTimers(timers);
        if (serverConfirmed) setCooldownTimersSynced(true);
      }, handleError),
      subscribeDonationRecordsForDateRange(
        storeId,
        monthStart,
        today,
        setMonthToDateDonations,
        handleError,
      ),
    ];
    if (monthCompletedThrough) {
      subscriptions.push(subscribeDailyWasteSummaries(
        storeId,
        monthStart,
        monthCompletedThrough,
        setMonthToDateSummaries,
        handleError,
      ));
      const summaryCheckKey = `waste-daily-summaries-v2-${storeId}-${today}`;
      const summaryRepairKey = `waste-daily-summaries-repair-v2-${storeId}`;
      if (localStorage.getItem(summaryCheckKey) !== 'complete') {
        const forceRebuild = localStorage.getItem(summaryRepairKey) !== 'complete';
        void ensureDailyWasteSummaries(storeId, monthStart, monthCompletedThrough, { forceRebuild })
          .then(() => {
            localStorage.setItem(summaryRepairKey, 'complete');
            localStorage.setItem(summaryCheckKey, 'complete');
          })
          .catch(handleError);
      }
    } else {
      setMonthToDateSummaries([]);
    }
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [storeId, today, monthStart, monthCompletedThrough]);

  useEffect(() => {
    if (!storeId) {
      setDiscardEvents([]);
      setDiscardPending(false);
      return;
    }
    setDiscardPending(false);
    return subscribeDiscardForDay(storeId, today, (events, hasPendingWrites) => {
      setDiscardEvents(events);
      setDiscardPending(hasPendingWrites);
    }, (caught) => {
      setError(caught.message);
      setReady(true);
    });
  }, [storeId, today]);

  return {
    settings,
    todayWaste,
    monthToDateSummaries,
    monthToDateDonations,
    monthStart,
    monthCompletedThrough,
    discardEvents,
    operationalWritePending: todayWastePending || discardPending,
    sosEntries,
    cooldownTimers,
    cooldownTimersSynced,
    error,
    ready,
    today,
  };
}
