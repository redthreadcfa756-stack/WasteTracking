import {
  AlertTriangle,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  CloudOff,
  Download,
  Gift,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Snowflake,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { User } from 'firebase/auth';
import {
  createDiscardEvent,
  createWasteEvent,
  recordDaypartUsageOutcome,
  loadDonationRecordsForDateRange,
  loadDemoDonationRecordsForDateRange,
  loadDemoWasteForDateRange,
  loadUsageDaysForDateRange,
  loadWasteForDateRange,
  login,
  logout,
  removeDiscardEvents,
  removeWasteEvents,
  removeExportDemoData,
  resetAllCooldownTimers,
  resetCooldownTimer,
  recordUsageHeartbeat,
  saveDonationRecord,
  saveSettings,
  saveSosEntry,
  seedExportDemoData,
  snoozeCooldownTimer,
  startOrJoinCooldownTimer,
} from './data';
import { COOLDOWN_PANS, DEFAULT_SETTINGS } from './defaults';
import {
  buildDaypartTopWasteItemsFromDailySummaries,
  buildTopDonationWasteItems,
  buildUsageRangeReport,
  buildUsageScore,
  completedEmptyDaypartsNeedingReview,
  daypartWaste,
  dayKey,
  cooldownProductQuantity,
  currentUsagePresenceSlot,
  buildWasteTrend,
  detectDaypart,
  displayProductQuantity,
  donationPrediction,
  formatDuration,
  formatDurationInput,
  formatMoney,
  formatQuantity,
  mergeActivity,
  parseDonationEntry,
  parseDuration,
  pendingQuantityAfterServerUpdate,
  productWaste,
  quantityAdjustmentFromDrag,
  isOperatingDayKey,
  operatingDayCount,
  nextOperatingDayKey,
  previousOperatingDayKey,
  RELIABLE_USAGE_LABEL,
  INSUFFICIENT_USAGE_LABEL,
  targetCasesForProduct,
  targetDollarForProduct,
  USAGE_PRESENCE_START_DAY,
  wasteExportPresetRange,
  withDerivedProductPricing,
  type WasteExportPreset,
  type WasteExportGrouping,
} from './domain';
import { createDonationWorkbook, createWasteTrendWorkbook } from './exportWorkbook';
import { firebaseConfigured } from './firebase';
import { useAuthUser, useDeviceName, useDonationDayData, useMember, useNow, useOnlineStatus, useStoreData, useUsageData, useUsageDayRecord, useUsageRangeData } from './hooks';
import type {
  AppSettings,
  CooldownTimer,
  DailyWasteSummary,
  DaypartId,
  DaypartUsageOutcome,
  DiscardEvent,
  DonationRecord,
  MemberProfile,
  MenuId,
  ProductConfig,
  WeightUnit,
  SosEntry,
  WasteEvent,
} from './types';

type TabId = 'waste' | 'discard' | 'sos' | 'donations' | 'usage' | 'admin';
type MenuSelection = 'auto' | MenuId;
type ExportPeriod = 1 | 30 | 60 | 90 | WasteExportPreset | 'custom';
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || '00756';
const WRITE_TIMEOUT_MS = 8_000;
const DISCARD_IDLE_TIMEOUT_MS = 45_000;
const MENU_OVERRIDE_IDLE_TIMEOUT_MS = 2 * 60_000;
const ADMIN_IDLE_TIMEOUT_MS = 2 * 60_000;
const IDLE_WARNING_GRACE_MS = 15_000;
const USAGE_REVIEW_DISMISS_MS = 15 * 60_000;

function useIdleAction(enabled: boolean, timeoutMs: number, onTimeout: () => void) {
  const action = useRef(onTimeout);

  useEffect(() => {
    action.current = onTimeout;
  }, [onTimeout]);

  useEffect(() => {
    if (!enabled) return;
    let lastActivityAt = Date.now();
    let timeoutId = 0;

    const checkIdle = () => {
      const remaining = timeoutMs - (Date.now() - lastActivityAt);
      if (remaining <= 0) {
        action.current();
        return;
      }
      timeoutId = window.setTimeout(checkIdle, remaining);
    };
    const markActivity = () => {
      lastActivityAt = Date.now();
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(checkIdle, timeoutMs);
    };
    const checkWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timeoutId);
      checkIdle();
    };

    markActivity();
    window.addEventListener('pointerdown', markActivity, true);
    window.addEventListener('keydown', markActivity, true);
    window.addEventListener('input', markActivity, true);
    window.addEventListener('change', markActivity, true);
    document.addEventListener('visibilitychange', checkWhenVisible);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('pointerdown', markActivity, true);
      window.removeEventListener('keydown', markActivity, true);
      window.removeEventListener('input', markActivity, true);
      window.removeEventListener('change', markActivity, true);
      document.removeEventListener('visibilitychange', checkWhenVisible);
    };
  }, [enabled, timeoutMs]);
}

function useUsageOutcomeRecorder({ member, currentDay, deviceName, notify }: {
  member: MemberProfile;
  currentDay: string;
  deviceName: string;
  notify: (message: string) => void;
}) {
  return useCallback(async (daypartId: DaypartId, outcome: DaypartUsageOutcome) => {
    try {
      await recordDaypartUsageOutcome({
        storeId: member.storeId,
        selectedDayKey: currentDay,
        daypartId,
        outcome,
        deviceName,
        recordedBy: member.uid,
      });
      const message = outcome === 'zero-waste'
        ? 'Zero Cool Down waste confirmed for that daypart.'
        : outcome === 'missed-waste'
          ? 'Known missed logging recorded. There is insufficient data for reliable insights.'
          : 'Uncertain daypart recorded. There is insufficient data for reliable insights.';
      notify(message);
      return true;
    } catch (caught) {
      notify(errorMessage(caught));
      return false;
    }
  }, [currentDay, deviceName, member.storeId, member.uid, notify]);
}
function confirmWrite<T>(write: Promise<T>): Promise<T> {
  return Promise.race([
    write,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error('Sync is taking too long. Check Recent activity before trying again.')), WRITE_TIMEOUT_MS);
    }),
  ]);
}

function timestampMillis(value: CooldownTimer['expiresAt']): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  return value.toMillis();
}

let cooldownAlarmAudio: HTMLAudioElement | null = null;
let cooldownAlarmBeepUrl: string | null = null;
let cooldownAlarmPrimed = false;
let cooldownAlarmPrime: Promise<boolean> | null = null;
let cooldownAlarmSequence = 0;
let cooldownAlarmSequenceActive = false;

function cooldownAlarmAnnouncementUrl(panId: CooldownTimer['id']): string {
  return `${import.meta.env.BASE_URL}audio/${panId}-announcement.wav`;
}

function createCooldownAlarmUrl(): string {
  const sampleRate = 16_000;
  const durationSeconds = 0.96;
  const sampleCount = Math.ceil(sampleRate * durationSeconds);
  const dataLength = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataLength, true);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const beepIndex = Math.floor(time / 0.32);
    const beepTime = time - beepIndex * 0.32;
    let sample = 0;
    if (beepIndex < 3 && beepTime < 0.24) {
      const attack = Math.min(1, beepTime / 0.012);
      const release = Math.min(1, (0.24 - beepTime) / 0.035);
      const envelope = Math.max(0, Math.min(attack, release));
      const fundamental = Math.sin(2 * Math.PI * 880 * time);
      const harmonic = Math.sin(2 * Math.PI * 1760 * time);
      sample = envelope * (fundamental * 0.72 + harmonic * 0.28) * 0.72;
    }
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32_767), true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function getCooldownAlarmAudio(): HTMLAudioElement {
  if (cooldownAlarmAudio) return cooldownAlarmAudio;
  cooldownAlarmBeepUrl = createCooldownAlarmUrl();
  cooldownAlarmAudio = new Audio(cooldownAlarmBeepUrl);
  cooldownAlarmAudio.preload = 'auto';
  return cooldownAlarmAudio;
}

function primeCooldownAlarm(): Promise<boolean> {
  if (cooldownAlarmPrimed) return Promise.resolve(true);
  if (cooldownAlarmIsPlaying()) {
    cooldownAlarmPrimed = true;
    return Promise.resolve(true);
  }
  if (cooldownAlarmPrime) return cooldownAlarmPrime;

  const audio = getCooldownAlarmAudio();
  const previousMuted = audio.muted;
  audio.loop = false;
  audio.muted = true;
  cooldownAlarmPrime = audio.play()
    .then(() => {
      audio.pause();
      audio.currentTime = 0;
      cooldownAlarmPrimed = true;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      audio.muted = previousMuted;
      cooldownAlarmPrime = null;
    });
  return cooldownAlarmPrime;
}

function stopCooldownAlarm() {
  cooldownAlarmSequence += 1;
  cooldownAlarmSequenceActive = false;
  if (cooldownAlarmAudio) {
    cooldownAlarmAudio.onended = null;
    cooldownAlarmAudio.onerror = null;
    cooldownAlarmAudio.loop = false;
    cooldownAlarmAudio.pause();
    cooldownAlarmAudio.currentTime = 0;
  }
}

function cooldownAlarmIsPlaying() {
  return cooldownAlarmSequenceActive
    || Boolean(cooldownAlarmAudio && !cooldownAlarmAudio.paused && !cooldownAlarmAudio.ended);
}

async function playCooldownAlarm({
  loop = false,
  panId,
  voiceVolume = 1,
}: {
  loop?: boolean;
  panId?: CooldownTimer['id'];
  voiceVolume?: number;
} = {}): Promise<boolean> {
  try {
    if (cooldownAlarmPrime) await cooldownAlarmPrime;
    stopCooldownAlarm();
    const sequence = ++cooldownAlarmSequence;
    const audio = getCooldownAlarmAudio();
    const beepUrl = cooldownAlarmBeepUrl || createCooldownAlarmUrl();
    const normalizedVoiceVolume = Math.max(0, Math.min(1, voiceVolume));
    cooldownAlarmBeepUrl = beepUrl;
    audio.volume = 1;
    audio.loop = false;
    cooldownAlarmSequenceActive = true;

    const playTrailingBeeps = () => {
      if (sequence !== cooldownAlarmSequence) return;
      audio.onerror = null;
      audio.onended = loop
        ? null
        : () => {
          if (sequence === cooldownAlarmSequence) cooldownAlarmSequenceActive = false;
        };
      audio.src = beepUrl;
      audio.load();
      audio.currentTime = 0;
      audio.volume = 1;
      audio.loop = loop;
      void audio.play().catch(() => {
        if (sequence === cooldownAlarmSequence) cooldownAlarmSequenceActive = false;
      });
    };

    const playRecordedAnnouncement = () => {
      audio.onended = null;
      if (!panId) {
        playTrailingBeeps();
        return;
      }

      let finished = false;
      const finishAnnouncement = () => {
        if (finished || sequence !== cooldownAlarmSequence) return;
        finished = true;
        audio.onended = null;
        audio.onerror = null;
        playTrailingBeeps();
      };
      audio.onended = finishAnnouncement;
      audio.onerror = finishAnnouncement;
      audio.src = cooldownAlarmAnnouncementUrl(panId);
      audio.load();
      audio.volume = normalizedVoiceVolume;
      void audio.play().catch(finishAnnouncement);
    };

    audio.onended = playRecordedAnnouncement;
    audio.onerror = null;
    audio.src = beepUrl;
    audio.load();
    await audio.play();
    cooldownAlarmPrimed = true;
    return true;
  } catch {
    cooldownAlarmSequenceActive = false;
    // The synchronized popup still appears when a browser blocks automatic audio.
    return false;
  }
}

function CooldownTimerItem({
  panLabel,
  timer,
  now,
  onCancel,
}: {
  panLabel: string;
  timer?: CooldownTimer;
  now: number;
  onCancel: () => void;
}) {
  const holdTimer = useRef<number | null>(null);
  const [holding, setHolding] = useState(false);
  const remainingMs = timer ? Math.max(0, timestampMillis(timer.expiresAt) - now) : 0;
  const remainingSeconds = Math.ceil(remainingMs / 1_000);
  const remainingPercent = timer ? Math.min(100, (remainingMs / (60 * 60 * 1000)) * 100) : 0;

  useEffect(() => () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
  }, []);

  const cancelHold = () => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
  };
  const startHold = () => {
    if (!timer) return;
    setHolding(true);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      setHolding(false);
      navigator.vibrate?.(50);
      onCancel();
    }, 900);
  };

  return (
    <button
      type="button"
      className={`cooldown-strip-item ${timer ? 'active' : ''}${holding ? ' is-holding' : ''}`}
      disabled={!timer}
      aria-label={timer ? `${panLabel}, ${formatDuration(remainingSeconds)} remaining. Hold to cancel.` : `${panLabel}, ready`}
      title={timer ? 'Hold to cancel this timer' : 'Ready for the next cool down entry'}
      onPointerDown={startHold}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onPointerLeave={cancelHold}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div>
        <span>{panLabel}</span>
        <strong>{timer ? formatDuration(remainingSeconds) : 'Ready'}</strong>
      </div>
      <div className="cooldown-progress" aria-hidden="true">
        <span style={{ width: `${remainingPercent}%` }} />
      </div>
    </button>
  );
}

const TABS: Array<{ id: TabId; label: string; icon: typeof Snowflake }> = [
  { id: 'waste', label: 'Cool Down', icon: Snowflake },
  { id: 'discard', label: 'Discard', icon: Trash2 },
  { id: 'sos', label: 'SOS', icon: Timer },
  { id: 'donations', label: 'Donations', icon: Gift },
  { id: 'usage', label: 'Usage', icon: ShieldCheck },
  { id: 'admin', label: 'Admin', icon: Settings },
];

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Something went wrong.';
  if (error.message.includes('auth/invalid-credential')) return 'The email or password is incorrect.';
  if (error.message.includes('auth/too-many-requests')) return 'Too many attempts. Wait a moment and try again.';
  if (error.message.includes('permission-denied')) return 'Your account does not have permission for that action.';
  return error.message;
}

function App() {
  const { user, loading, error } = useAuthUser();
  const memberState = useMember(user);

  if (!firebaseConfigured) return <ConfigurationRequired />;
  if (loading || (user && memberState.loading)) return <FullScreenMessage>Connecting to the shared store…</FullScreenMessage>;
  if (error || memberState.error) return <FullScreenMessage tone="error">{error || memberState.error}</FullScreenMessage>;
  if (!user || !memberState.member) return <FullScreenMessage tone="error">Could not connect automatically. Enable Anonymous sign-in in Firebase Authentication, then reload.</FullScreenMessage>;
  return <Dashboard user={user} member={memberState.member} />;
}

function ConfigurationRequired() {
  return (
    <main className="center-shell">
      <section className="auth-card">
        <div className="brand-mark"><CloudOff aria-hidden="true" /></div>
        <p className="eyebrow">Setup required</p>
        <h1>Connect Firebase</h1>
        <p>Add the six <code>VITE_FIREBASE_*</code> values from <code>.env.example</code>, then restart the app.</p>
      </section>
    </main>
  );
}

function FullScreenMessage({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return <main className={`center-shell ${tone === 'error' ? 'error-text' : ''}`}><p>{children}</p></main>;
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark"><Snowflake aria-hidden="true" /></div>
        <p className="eyebrow">Shared operations</p>
        <h1>Cool Down + SOS</h1>
        <p>Sign in once on this device to sync with the store.</p>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}

function MissingMembership({ user }: { user: User }) {
  return (
    <main className="center-shell">
      <section className="auth-card">
        <div className="brand-mark"><ShieldCheck aria-hidden="true" /></div>
        <h1>Account not assigned</h1>
        <p>Create <code>members/{user.uid}</code> in Firestore or run the seed script, then reload.</p>
        <button className="secondary-button" onClick={() => logout()}>Sign out</button>
      </section>
    </main>
  );
}

function Dashboard({ user, member }: { user: User; member: MemberProfile }) {
  const now = useNow();
  const online = useOnlineStatus();
  const deviceName = useDeviceName();
  const storeData = useStoreData(member.storeId, now);
  const settings = storeData.settings || DEFAULT_SETTINGS;
  const [activeTab, setActiveTab] = useState<TabId>('waste');
  const [menuSelection, setMenuSelection] = useState<MenuSelection>('auto');
  const [testDaypartEnabled, setTestDaypartEnabled] = useState(false);
  const [testWasteEvents, setTestWasteEvents] = useState<WasteEvent[]>([]);
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [warning, setWarning] = useState<{ daypart: string; total: number; target: number } | null>(null);
  const [warningMutedUntil, setWarningMutedUntil] = useState(0);
  const [toast, setToast] = useState('');
  const toastTimeout = useRef(0);
  const [adminDirty, setAdminDirty] = useState(false);
  const [adminIdleWarning, setAdminIdleWarning] = useState(false);
  const [timerNow, setTimerNow] = useState(Date.now());
  const [timerActionBusy, setTimerActionBusy] = useState(false);
  const [alarmPlaybackBlocked, setAlarmPlaybackBlocked] = useState(false);
  const alarmActionInProgress = useRef(false);
  const attemptedPresenceSlot = useRef('');
  const visibleTabs = TABS.filter((tab) => (
    (tab.id !== 'sos' || settings.sosEnabled)
    && (tab.id !== 'discard' || settings.discardTrackingEnabled)
  ));

  const notify = useCallback((message: string) => {
    window.clearTimeout(toastTimeout.current);
    setToast(message);
    toastTimeout.current = window.setTimeout(() => {
      setToast((current) => current === message ? '' : current);
    }, 2_600);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimeout.current), []);

  const returnToCooldown = useCallback((message: string) => {
    setAdminIdleWarning(false);
    setAdminDirty(false);
    setMenuSelection('auto');
    setActiveTab('waste');
    notify(message);
  }, [notify]);

  const presenceSlot = currentUsagePresenceSlot(settings.dayparts, now);

  useEffect(() => {
    if (
      activeTab !== 'waste'
      || testDaypartEnabled
      || !presenceSlot
      || !isOperatingDayKey(storeData.today)
      || storeData.today < USAGE_PRESENCE_START_DAY
    ) return;
    const recordPresence = () => {
      if (
        document.visibilityState !== 'visible'
        || attemptedPresenceSlot.current === presenceSlot.slotKey
      ) return;
      attemptedPresenceSlot.current = presenceSlot.slotKey;
      void recordUsageHeartbeat({
        storeId: member.storeId,
        selectedDayKey: storeData.today,
        slotKey: presenceSlot.slotKey,
        deviceName,
        recordedBy: member.uid,
      }).catch((caught) => notify(`Usage tracking: ${errorMessage(caught)}`));
    };

    recordPresence();
    document.addEventListener('visibilitychange', recordPresence);
    return () => document.removeEventListener('visibilitychange', recordPresence);
  }, [activeTab, deviceName, member.storeId, member.uid, notify, presenceSlot?.slotKey, storeData.today, testDaypartEnabled]);

  useEffect(() => {
    const syncClock = () => setTimerNow(Date.now());
    const syncVisibleClock = () => {
      if (document.visibilityState === 'visible') syncClock();
    };
    const interval = window.setInterval(syncClock, 1_000);
    window.addEventListener('focus', syncClock);
    window.addEventListener('pageshow', syncClock);
    document.addEventListener('visibilitychange', syncVisibleClock);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', syncClock);
      window.removeEventListener('pageshow', syncClock);
      document.removeEventListener('visibilitychange', syncVisibleClock);
    };
  }, []);

  useEffect(() => {
    if (!testDaypartEnabled) setTestWasteEvents([]);
  }, [testDaypartEnabled]);

  useEffect(() => {
    if (
      (activeTab === 'sos' && !settings.sosEnabled)
      || (activeTab === 'discard' && !settings.discardTrackingEnabled)
    ) {
      setActiveTab('waste');
    }
  }, [activeTab, settings.sosEnabled, settings.discardTrackingEnabled]);

  useIdleAction(activeTab === 'discard', DISCARD_IDLE_TIMEOUT_MS, () => {
    returnToCooldown('Returned to Cool Down after 45 seconds of inactivity.');
  });

  useIdleAction(
    menuSelection !== 'auto' && (activeTab === 'waste' || activeTab === 'discard'),
    MENU_OVERRIDE_IDLE_TIMEOUT_MS,
    () => {
      setMenuSelection('auto');
      notify('Menu returned to automatic after 2 minutes of inactivity.');
    },
  );

  useEffect(() => {
    if (activeTab !== 'waste' && activeTab !== 'discard' && menuSelection !== 'auto') {
      setMenuSelection('auto');
    }
  }, [activeTab, menuSelection]);

  useIdleAction(activeTab === 'admin' && !adminIdleWarning, ADMIN_IDLE_TIMEOUT_MS, () => {
    if (adminDirty) setAdminIdleWarning(true);
    else returnToCooldown('Admin locked after 2 minutes of inactivity.');
  });

  useEffect(() => {
    if (!adminIdleWarning) return;
    const timeoutId = window.setTimeout(() => {
      returnToCooldown('Unsaved Admin changes were discarded and Admin was locked.');
    }, IDLE_WARNING_GRACE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [adminIdleWarning, returnToCooldown]);

  useEffect(() => {
    if (activeTab === 'donations' || activeTab === 'admin' || adminPrompt) return;
    const primeAudio = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-suppresses-cooldown-alarm="true"]')) return;
      void primeCooldownAlarm();
    };
    window.addEventListener('pointerdown', primeAudio);
    window.addEventListener('keydown', primeAudio);
    return () => {
      window.removeEventListener('pointerdown', primeAudio);
      window.removeEventListener('keydown', primeAudio);
    };
  }, [activeTab, adminPrompt]);

  const testDaypartActive = testDaypartEnabled && activeTab === 'waste';
  const cooldownAlarmSuppressed = activeTab === 'donations' || activeTab === 'admin' || adminPrompt;
  const cooldownTimersReadyForAlarm = storeData.cooldownTimersSynced || !online;
  const expiredTimer = settings.cooldownTimersEnabled
    && cooldownTimersReadyForAlarm
    && !testDaypartActive
    && !cooldownAlarmSuppressed
    ? storeData.cooldownTimers.find((timer) => {
      const expiration = timestampMillis(timer.expiresAt);
      return timer.active && expiration > 0 && expiration <= timerNow;
    })
    : undefined;
  const expiredTimerKey = expiredTimer
    ? `${expiredTimer.id}:${timestampMillis(expiredTimer.expiresAt)}`
    : '';
  const expiredTimerPanId = expiredTimer?.id;

  useEffect(() => {
    if (!expiredTimerKey) {
      alarmActionInProgress.current = false;
      stopCooldownAlarm();
      setAlarmPlaybackBlocked(false);
      return;
    }

    alarmActionInProgress.current = false;
    navigator.vibrate?.([300, 150, 300, 150, 600]);
    let disposed = false;
    let attemptInFlight = false;
    const attemptAlarm = async (event?: Event) => {
      const target = event?.target;
      if (
        disposed
        || (target instanceof Element && Boolean(target.closest('[data-suppresses-cooldown-alarm="true"]')))
        || attemptInFlight
        || alarmActionInProgress.current
        || cooldownAlarmSequenceActive
      ) return;
      attemptInFlight = true;
      if (cooldownAlarmPrime) await cooldownAlarmPrime;
      if (disposed || alarmActionInProgress.current) {
        attemptInFlight = false;
        return;
      }
      const played = await playCooldownAlarm({
        loop: true,
        panId: expiredTimerPanId,
        voiceVolume: settings.alarmVoiceVolume,
      });
      attemptInFlight = false;
      if (!disposed) setAlarmPlaybackBlocked(!played);
    };
    const retryOnVisible = () => {
      if (document.visibilityState === 'visible') void attemptAlarm();
    };

    void attemptAlarm();
    window.addEventListener('pointerdown', attemptAlarm);
    window.addEventListener('focus', attemptAlarm);
    window.addEventListener('pageshow', attemptAlarm);
    document.addEventListener('visibilitychange', retryOnVisible);
    return () => {
      disposed = true;
      window.removeEventListener('pointerdown', attemptAlarm);
      window.removeEventListener('focus', attemptAlarm);
      window.removeEventListener('pageshow', attemptAlarm);
      document.removeEventListener('visibilitychange', retryOnVisible);
      stopCooldownAlarm();
    };
  }, [expiredTimerKey]);

  const completeCooldownTimer = async (timer: CooldownTimer) => {
    alarmActionInProgress.current = true;
    stopCooldownAlarm();
    setTimerActionBusy(true);
    try {
      await resetCooldownTimer(member.storeId, timer.id);
      notify(`${timer.panLabel} reset and ready for the next cool down entry.`);
    } catch (caught) {
      alarmActionInProgress.current = false;
      notify(errorMessage(caught));
      void playCooldownAlarm({
        loop: true,
        panId: timer.id,
        voiceVolume: settings.alarmVoiceVolume,
      });
    } finally {
      setTimerActionBusy(false);
    }
  };

  const cancelCooldownTimer = async (timer: CooldownTimer) => {
    try {
      await resetCooldownTimer(member.storeId, timer.id);
      notify(`${timer.panLabel} timer canceled.`);
    } catch (caught) {
      notify(errorMessage(caught));
    }
  };

  const snoozeExpiredCooldownTimer = async (timer: CooldownTimer) => {
    alarmActionInProgress.current = true;
    stopCooldownAlarm();
    setTimerActionBusy(true);
    try {
      await snoozeCooldownTimer(member.storeId, timer.id);
      setTimerNow(Date.now());
      notify(`${timer.panLabel} snoozed for 1 minute on every device.`);
    } catch (caught) {
      alarmActionInProgress.current = false;
      notify(errorMessage(caught));
      void playCooldownAlarm({
        loop: true,
        panId: timer.id,
        voiceVolume: settings.alarmVoiceVolume,
      });
    } finally {
      setTimerActionBusy(false);
    }
  };

  const silenceCooldownAlarmForNavigation = () => {
    if (expiredTimerKey) alarmActionInProgress.current = true;
    stopCooldownAlarm();
    setAlarmPlaybackBlocked(false);
  };

  const selectTab = (tab: TabId) => {
    if (tab === activeTab) return;
    if (tab === 'admin') {
      silenceCooldownAlarmForNavigation();
      setAdminPrompt(true);
      return;
    }
    if (tab === 'donations') silenceCooldownAlarmForNavigation();
    setActiveTab(tab);
  };

  const nativeDaypartId = detectDaypart(settings.dayparts, now);
  const nativeDaypart = settings.dayparts.find((part) => part.id === nativeDaypartId) || settings.dayparts[0];
  const effectiveMenu = menuSelection === 'auto' ? nativeDaypart.menu : menuSelection;
  const targetDaypartId: DaypartId = effectiveMenu === 'breakfast'
    ? 'breakfast'
    : nativeDaypartId === 'breakfast' ? 'lunch' : nativeDaypartId;
  const syncLabel = storeData.operationalWritePending
    ? online ? 'Saving…' : 'Waiting to sync'
    : online ? 'Synced' : 'Offline';

  if (!storeData.ready) return <FullScreenMessage>Loading live store data…</FullScreenMessage>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Real-time store operations</p>
          <h1>Cool Down + SOS</h1>
        </div>
        <div className="header-actions">
          <span className={`sync-pill ${online ? storeData.operationalWritePending ? 'pending' : '' : 'offline'}`}>
            {!online ? <CloudOff aria-hidden="true" /> : storeData.operationalWritePending ? <Clock3 aria-hidden="true" /> : <Cloud aria-hidden="true" />}
            {syncLabel}
          </span>
        </div>
      </header>

      {settings.cooldownTimersEnabled && !testDaypartActive && (
        <section className="cooldown-strip" aria-label="Cooldown pan timers">
          {COOLDOWN_PANS.map((pan) => {
            const timer = storeData.cooldownTimers.find((candidate) => candidate.id === pan.id && candidate.active);
            return (
              <CooldownTimerItem
                key={pan.id}
                panLabel={pan.label}
                timer={timer}
                now={timerNow}
                onCancel={() => timer && void cancelCooldownTimer(timer)}
              />
            );
          })}
        </section>
      )}

      {storeData.error && <div className="error-banner" role="alert">{storeData.error}</div>}

      <nav
        className={`tabbar tab-count-${visibleTabs.length}`}
        aria-label="Primary"
        style={{ gridTemplateColumns: `repeat(${visibleTabs.length}, minmax(0, 1fr))` }}
      >
        {visibleTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={activeTab === id ? 'active' : ''}
            data-suppresses-cooldown-alarm={id === 'admin' || id === 'donations' ? 'true' : undefined}
            onPointerDown={() => {
              if (id === 'admin' || id === 'donations') silenceCooldownAlarmForNavigation();
            }}
            onClick={() => selectTab(id)}
            aria-current={activeTab === id ? 'page' : undefined}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <main className="content">
        {activeTab === 'waste' && (
          <WasteTab
            settings={settings}
            events={storeData.todayWaste}
            currentDay={storeData.today}
            now={now}
            monthToDateSummaries={storeData.monthToDateSummaries}
            monthToDateDonations={storeData.monthToDateDonations}
            monthStartDayKey={storeData.monthStart}
            monthCompletedThrough={storeData.monthCompletedThrough}
            discardEvents={storeData.discardEvents}
            cooldownTimers={storeData.cooldownTimers}
            testMode={testDaypartEnabled}
            testEvents={testWasteEvents}
            setTestEvents={setTestWasteEvents}
            member={member}
            deviceName={deviceName}
            effectiveMenu={effectiveMenu}
            menuSelection={menuSelection}
            setMenuSelection={setMenuSelection}
            targetDaypartId={targetDaypartId}
            warningMutedUntil={warningMutedUntil}
            showWarning={setWarning}
            notify={notify}
          />
        )}
        {activeTab === 'discard' && settings.discardTrackingEnabled && (
          <DiscardTab
            settings={settings}
            events={storeData.discardEvents}
            coolDownEvents={storeData.todayWaste}
            member={member}
            deviceName={deviceName}
            effectiveMenu={effectiveMenu}
            menuSelection={menuSelection}
            setMenuSelection={setMenuSelection}
            targetDaypartId={targetDaypartId}
            warningMutedUntil={warningMutedUntil}
            showWarning={setWarning}
            notify={notify}
          />
        )}
        {activeTab === 'sos' && settings.sosEnabled && (
          <SosTab
            settings={settings}
            entries={storeData.sosEntries}
            member={member}
            deviceName={deviceName}
            today={storeData.today}
            initialDaypartId={targetDaypartId}
            notify={notify}
          />
        )}
        {activeTab === 'donations' && (
          <DonationsTab
            settings={settings}
            member={member}
            currentDay={storeData.today}
            notify={notify}
          />
        )}
        {activeTab === 'usage' && (
          <UsageTab
            settings={settings}
            currentDay={storeData.today}
            now={now}
            member={member}
            deviceName={deviceName}
            notify={notify}
          />
        )}
        {activeTab === 'admin' && (
          <AdminTab
            settings={settings}
            member={member}
            deviceName={deviceName}
            testDaypartEnabled={testDaypartEnabled}
            setTestDaypartEnabled={setTestDaypartEnabled}
            notify={notify}
            onDirtyChange={setAdminDirty}
          />
        )}
      </main>

      <footer className="mobile-footer">
        <span>{member.displayName}</span>
        <span>{deviceName}</span>
      </footer>

      {adminPrompt && (
        <AdminUnlock
          onClose={() => {
            stopCooldownAlarm();
            setAdminPrompt(false);
          }}
          onUnlocked={() => {
            stopCooldownAlarm();
            setAdminPrompt(false);
            setAdminDirty(false);
            setActiveTab('admin');
          }}
        />
      )}
      {warning && (
        <Modal title="Daypart waste is over target" icon={<AlertTriangle />} onClose={() => {
          setWarning(null);
          setWarningMutedUntil(Date.now() + settings.warningCooldownSeconds * 1000);
        }}>
          <p>{warning.daypart} waste is now {formatMoney(warning.total)} against a {formatMoney(warning.target)} target.</p>
          <button className="primary-button" onClick={() => {
            setWarning(null);
            setWarningMutedUntil(Date.now() + settings.warningCooldownSeconds * 1000);
          }}>Dismiss for {settings.warningCooldownSeconds} seconds</button>
        </Modal>
      )}
      {expiredTimer && (
        <Modal
          title={`${expiredTimer.panLabel} cooldown complete`}
          icon={<Timer />}
          onClose={() => {
            if (!timerActionBusy) void completeCooldownTimer(expiredTimer);
          }}
        >
          <p>Wrap the pan and place it in the walk-in cooler.</p>
          {alarmPlaybackBlocked && (
            <p className="form-error" role="alert">
              This browser blocked automatic sound. Tap Play alarm to enable it.
            </p>
          )}
          <div className="cooldown-expired-actions">
            <button
              className="secondary-button"
              disabled={timerActionBusy}
              onClick={() => {
                alarmActionInProgress.current = false;
                void playCooldownAlarm({
                  loop: true,
                  panId: expiredTimer.id,
                  voiceVolume: settings.alarmVoiceVolume,
                }).then((played) => {
                  setAlarmPlaybackBlocked(!played);
                });
              }}
            >
              <Timer aria-hidden="true" /> {alarmPlaybackBlocked ? 'Play alarm' : 'Replay alarm'}
            </button>
            <button
              className="secondary-button"
              disabled={timerActionBusy}
              onClick={() => void snoozeExpiredCooldownTimer(expiredTimer)}
            >
              <Clock3 aria-hidden="true" /> Snooze 1 minute
            </button>
            <button
              className="primary-button"
              disabled={timerActionBusy}
              onClick={() => void completeCooldownTimer(expiredTimer)}
            >
              <Check /> {timerActionBusy ? 'Saving…' : 'Pan wrapped and moved'}
            </button>
          </div>
        </Modal>
      )}
      {adminIdleWarning && (
        <Modal title="Admin inactive" icon={<AlertTriangle />} onClose={() => setAdminIdleWarning(false)}>
          <p>Admin has unsaved changes. This device will discard them, lock Admin, and return to Cool Down in 15 seconds.</p>
          <div className="idle-warning-actions">
            <button className="secondary-button" onClick={() => setAdminIdleWarning(false)}>Stay in Admin</button>
            <button className="primary-button" onClick={() => returnToCooldown('Unsaved Admin changes were discarded and Admin was locked.')}>Discard changes and return</button>
          </div>
        </Modal>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function WasteTab({
  settings,
  events,
  currentDay,
  now,
  monthToDateSummaries,
  monthToDateDonations,
  monthStartDayKey,
  monthCompletedThrough,
  discardEvents,
  cooldownTimers,
  testMode,
  testEvents,
  setTestEvents,
  member,
  deviceName,
  effectiveMenu,
  menuSelection,
  setMenuSelection,
  targetDaypartId,
  warningMutedUntil,
  showWarning,
  notify,
}: {
  settings: AppSettings;
  events: WasteEvent[];
  currentDay: string;
  now: Date;
  monthToDateSummaries: DailyWasteSummary[];
  monthToDateDonations: DonationRecord[];
  monthStartDayKey: string;
  monthCompletedThrough: string;
  discardEvents: DiscardEvent[];
  cooldownTimers: CooldownTimer[];
  testMode: boolean;
  testEvents: WasteEvent[];
  setTestEvents: (update: (events: WasteEvent[]) => WasteEvent[]) => void;
  member: MemberProfile;
  deviceName: string;
  effectiveMenu: MenuId;
  menuSelection: MenuSelection;
  setMenuSelection: (selection: MenuSelection) => void;
  targetDaypartId: DaypartId;
  warningMutedUntil: number;
  showWarning: (warning: { daypart: string; total: number; target: number }) => void;
  notify: (message: string) => void;
}) {
  const [nuggetPicker, setNuggetPicker] = useState<ProductConfig | null>(null);
  const [pendingPanQuantities, setPendingPanQuantities] = useState<Record<string, number>>({});
  const [usageOutcomeBusy, setUsageOutcomeBusy] = useState<DaypartId | null>(null);
  const [usageReviewDaypart, setUsageReviewDaypart] = useState<DaypartId | null>(null);
  const [, setUsageDismissalVersion] = useState(0);
  const previousServerPanQuantities = useRef<Record<string, number> | null>(null);
  const usageDay = useUsageDayRecord(member.storeId, currentDay);
  const recordUsageOutcome = useUsageOutcomeRecorder({ member, currentDay, deviceName, notify });
  const products = settings.products.filter((product) => (
    product.menus.includes(effectiveMenu) && !product.discardOnly
  ));
  const daypart = settings.dayparts.find((candidate) => candidate.id === targetDaypartId)!;
  const monthToDateTopWaste = buildDaypartTopWasteItemsFromDailySummaries(
    monthToDateSummaries,
    settings,
  );
  const monthToDateTopDonations = buildTopDonationWasteItems(
    monthToDateDonations,
    settings,
  );
  const monthToDateLabel = new Date(`${monthStartDayKey}T12:00:00`).toLocaleDateString([], {
    month: 'long',
    year: 'numeric',
  });
  const monthToDateCoverage = monthCompletedThrough
    ? `Through ${new Date(`${monthCompletedThrough}T12:00:00`).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
    })}`
    : 'No completed days yet';
  const emptyDaypartsNeedingReview = completedEmptyDaypartsNeedingReview({
    dayparts: settings.dayparts,
    events,
    usageRecord: usageDay.record,
    selectedDayKey: currentDay,
    now,
  });
  const pendingUsageReview = usageDay.loading || usageDay.error ? undefined : emptyDaypartsNeedingReview.find((part) => {
    const dismissalKey = `usage-review-dismissed-${member.storeId}-${currentDay}-${part.id}`;
    return Number(localStorage.getItem(dismissalKey) || 0) <= now.getTime();
  });
  const displayedEvents = testMode ? testEvents : events;
  const menuEvents = displayedEvents.filter((event) => event.menu === effectiveMenu);
  const coolDownDaypartEvents = displayedEvents.filter((event) => event.daypartId === targetDaypartId);
  const discardDaypartEvents = testMode
    ? []
    : discardEvents.filter((event) => event.daypartId === targetDaypartId);
  const combinedDaypartEvents = [...coolDownDaypartEvents, ...discardDaypartEvents];
  const activeWaste = daypartWaste(combinedDaypartEvents, targetDaypartId);
  const merged = mergeActivity(menuEvents, settings.products);
  const targetVariance = activeWaste.cost - daypart.totalDollarTarget;
  const varianceDetail = Math.abs(targetVariance) < 0.005
    ? 'On target'
    : `${formatMoney(Math.abs(targetVariance))} ${targetVariance > 0 ? 'over' : 'under'} target`;
  const serverPanQuantities = Object.fromEntries(settings.products.map((product) => {
    const pan = COOLDOWN_PANS.find((candidate) => candidate.productIds.includes(product.id));
    const activeTimer = pan
      ? cooldownTimers.find((timer) => timer.id === pan.id && timer.active)
      : undefined;
    return [product.id, cooldownProductQuantity(activeTimer, product.id) || 0];
  }));
  const serverPanSignature = settings.products
    .map((product) => `${product.id}:${serverPanQuantities[product.id] || 0}`)
    .join('|');

  const saveUsageOutcome = async (daypartId: DaypartId, outcome: DaypartUsageOutcome) => {
    setUsageOutcomeBusy(daypartId);
    const saved = await recordUsageOutcome(daypartId, outcome);
    setUsageOutcomeBusy(null);
    if (saved) {
      localStorage.removeItem(`usage-review-dismissed-${member.storeId}-${currentDay}-${daypartId}`);
      setUsageReviewDaypart(null);
    }
  };

  useLayoutEffect(() => {
    const previous = previousServerPanQuantities.current;
    previousServerPanQuantities.current = serverPanQuantities;
    if (!previous) return;

    setPendingPanQuantities((current) => {
      let changed = false;
      const next = { ...current };
      settings.products.forEach((product) => {
        const productId = product.id;
        const pending = current[productId] || 0;
        const reconciled = pendingQuantityAfterServerUpdate(
          pending,
          previous[productId] || 0,
          serverPanQuantities[productId] || 0,
        );
        if (reconciled === pending) return;
        changed = true;
        if (reconciled === 0) delete next[productId];
        else next[productId] = reconciled;
      });
      return changed ? next : current;
    });
  }, [serverPanSignature]);

  const adjustPendingPanQuantity = (productId: string, adjustment: number) => {
    setPendingPanQuantities((current) => {
      const nextQuantity = (current[productId] || 0) + adjustment;
      if (nextQuantity === 0) {
        const next = { ...current };
        delete next[productId];
        return next;
      }
      return { ...current, [productId]: nextQuantity };
    });
  };

  const adjustWaste = async (product: ProductConfig, equivalentUnits: number) => {
    const isCup = product.trackingUnit === 'cup' && Math.abs(equivalentUnits) === (product.unitsPerCup || 14);
    const displayQuantity = isCup ? Math.sign(equivalentUnits) : equivalentUnits;
    const displayUnit = isCup ? 'cup' : 'each';
    const eventData: Omit<WasteEvent, 'id' | 'eventAt'> = {
      storeId: member.storeId,
      productId: product.id,
      productName: product.name,
      equivalentUnits,
      displayQuantity,
      displayUnit,
      unitCostSnapshot: product.unitCost,
      dayKey: dayKey(),
      daypartId: targetDaypartId,
      menu: effectiveMenu,
      deviceName,
      createdBy: member.uid,
      createdByName: member.displayName,
    };

    if (testMode) {
      const testEvent: WasteEvent = {
        id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        eventAt: new Date(),
        ...eventData,
      };
      setTestEvents((current) => [testEvent, ...current]);
      return;
    }

    const matchingPans = COOLDOWN_PANS.filter((pan) => pan.productIds.includes(product.id));
    const activeMatchingPan = matchingPans.some((pan) => (
      cooldownTimers.some((timer) => timer.id === pan.id && timer.active)
    ));
    const optimisticallyAdjustPan = settings.cooldownTimersEnabled
      && matchingPans.length > 0
      && (equivalentUnits > 0 || activeMatchingPan);
    if (optimisticallyAdjustPan) {
      adjustPendingPanQuantity(product.id, equivalentUnits);
    }

    try {
      await confirmWrite(createWasteEvent(eventData));
      if (settings.cooldownTimersEnabled) {
        await confirmWrite(Promise.all(matchingPans.map((pan) => startOrJoinCooldownTimer({
          storeId: member.storeId,
          panId: pan.id,
          panLabel: pan.label,
          productId: product.id,
          equivalentUnits,
          createdBy: member.uid,
          createdByName: member.displayName,
        }))));
      }
      const projectedCost = activeWaste.cost + equivalentUnits * product.unitCost;
      if (projectedCost > daypart.totalDollarTarget && Date.now() >= warningMutedUntil) {
        showWarning({ daypart: daypart.label, total: projectedCost, target: daypart.totalDollarTarget });
      }
    } catch (caught) {
      if (optimisticallyAdjustPan) {
        adjustPendingPanQuantity(product.id, -equivalentUnits);
      }
      notify(errorMessage(caught));
    }
  };

  const subtractWaste = (
    product: ProductConfig,
    totalUnits: number,
    requestedQuantity = product.tapQuantity,
  ) => {
    if (totalUnits <= 0) {
      notify(`No ${product.name} cool down entry to subtract.`);
      return;
    }
    const adjustment = Math.min(requestedQuantity, totalUnits);
    void adjustWaste(product, -adjustment);
  };

  const undoLast = async () => {
    const latest = displayedEvents.find((event) => event.createdBy === member.uid);
    if (!latest) return;
    if (testMode) {
      setTestEvents((current) => current.filter((event) => event.id !== latest.id));
      notify('Last test entry removed.');
      return;
    }
    try {
      await removeWasteEvents(member.storeId, [latest.id]);
      if (settings.cooldownTimersEnabled) {
        const matchingPans = COOLDOWN_PANS.filter((pan) => pan.productIds.includes(latest.productId));
        await Promise.all(matchingPans.map((pan) => startOrJoinCooldownTimer({
          storeId: member.storeId,
          panId: pan.id,
          panLabel: pan.label,
          productId: latest.productId,
          equivalentUnits: -latest.equivalentUnits,
          createdBy: member.uid,
          createdByName: member.displayName,
          startIfInactive: false,
        })));
      }
      notify('Last cool down entry removed.');
    } catch (caught) {
      notify(errorMessage(caught));
    }
  };

  return (
    <section className="panel-stack">
      {testMode && (
        <div className="test-daypart-banner" role="status">
          <div>
            <strong>Test Daypart · This device only</strong>
            <span>Nothing entered here is saved or sent to Firebase.</span>
          </div>
          <button
            className="secondary-button small"
            disabled={testEvents.length === 0}
            onClick={() => {
              setTestEvents(() => []);
              notify('Test Daypart reset.');
            }}
          >
            <RotateCcw aria-hidden="true" /> Reset test
          </button>
        </div>
      )}
      {!testMode && pendingUsageReview && (
        <div className="usage-review-reminder" role="status">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>{pendingUsageReview.label} ended with no Cool Down entries.</strong>
            <span>Review what happened so today’s usage score is accurate.</span>
          </div>
          <div className="usage-review-reminder-actions">
            <button
              className="secondary-button small"
              onClick={() => {
                const dismissalKey = `usage-review-dismissed-${member.storeId}-${currentDay}-${pendingUsageReview.id}`;
                localStorage.setItem(dismissalKey, String(Date.now() + USAGE_REVIEW_DISMISS_MS));
                setUsageDismissalVersion((current) => current + 1);
              }}
            >
              Later
            </button>
            <button className="primary-button small" onClick={() => setUsageReviewDaypart(pendingUsageReview.id)}>
              Review now
            </button>
          </div>
        </div>
      )}
      <OperationalHeading
        eyebrow={testMode ? 'Test Daypart · Local session' : `${daypart.label} · ${formatMinutes(daypart.startMinutes)}–${formatMinutes(daypart.endMinutes)}`}
        title={testMode ? 'Practice cool down entry' : 'Log product entering cool down'}
        effectiveMenu={effectiveMenu}
        menuSelection={menuSelection}
        setMenuSelection={setMenuSelection}
      />

      <DaypartWasteTarget
        label={`${testMode ? 'Test · ' : ''}${daypart.label} waste / target`}
        cost={activeWaste.cost}
        target={daypart.totalDollarTarget}
        detail={`${varianceDetail}${testMode ? ' · Local only' : ' · Cool Down + discard'}`}
      />

      <div className="waste-grid">
        {products.map((product) => {
          const coolDownTotals = productWaste(coolDownDaypartEvents, product.id);
          const combinedTotals = productWaste(combinedDaypartEvents, product.id);
          const pan = COOLDOWN_PANS.find((candidate) => candidate.productIds.includes(product.id));
          const activeTimer = !testMode && settings.cooldownTimersEnabled && pan
            ? cooldownTimers.find((timer) => timer.id === pan.id && timer.active)
            : undefined;
          const pendingPanQuantity = pendingPanQuantities[product.id] || 0;
          const syncedPanUnits = cooldownProductQuantity(activeTimer, product.id);
          const currentPanUnits = testMode
            ? pan ? Math.max(0, coolDownTotals.units) : null
            : pendingPanQuantity !== 0
              ? Math.max(0, (syncedPanUnits || 0) + pendingPanQuantity)
              : syncedPanUnits;
          const currentPanLabel = testMode
            ? pan ? `${pan.label} · Test pan` : 'No cooldown pan assigned'
            : !settings.cooldownTimersEnabled
              ? 'Cooldown pans off'
              : !pan
                ? 'No cooldown pan assigned'
                : activeTimer || pendingPanQuantity > 0 ? `${pan.label} · Current pan` : `${pan.label} · Ready`;
          return (
            <div className="waste-card-wrap" key={product.id}>
              <ProductTrackingCard
                product={product}
                primaryLabel={currentPanLabel}
                primaryValue={currentPanUnits === null ? 'No active pan' : displayProductQuantity(product, currentPanUnits)}
                primaryEmpty={currentPanUnits === null}
                secondaryText={`Daypart waste: ${displayProductQuantity(product, combinedTotals.units)} · ${formatMoney(combinedTotals.cost)}`}
                onAdd={() => adjustWaste(product, product.tapQuantity)}
                onSubtract={() => subtractWaste(product, coolDownTotals.units)}
                onAdjustQuantity={settings.cardScrubEnabled
                  ? (adjustment) => {
                    if (adjustment > 0) {
                      void adjustWaste(product, adjustment);
                    } else if (adjustment < 0) {
                      subtractWaste(product, coolDownTotals.units, Math.abs(adjustment));
                    }
                  }
                  : undefined}
              />
              {product.trackingUnit === 'cup' && !settings.cardScrubEnabled && (
                <button
                  className="individual-nuggets-button"
                  onClick={() => setNuggetPicker(product)}
                >
                  Add individual nuggets
                </button>
              )}
            </div>
          );
        })}
      </div>

      <RecentProductActivity
        eyebrow={testMode ? 'Temporary entries · Not saved' : 'Merged by product and minute'}
        title={testMode ? 'Test activity' : 'Recent activity'}
        emptyText={testMode ? 'No test cool down entered for this menu.' : 'No cool down logged for this menu yet.'}
        entries={merged}
        products={settings.products}
        onUndo={undoLast}
        undoDisabled={!displayedEvents.some((event) => event.createdBy === member.uid)}
      />

      {!testMode && (
        <section className="mtd-waste-summary" aria-labelledby="mtd-waste-title">
          <div className="section-heading activity-heading">
            <div>
              <p className="eyebrow">
                {monthToDateLabel} · {monthToDateCoverage} · Updated daily · Cool Down only
              </p>
              <h2 id="mtd-waste-title">Month-to-date top waste by daypart</h2>
            </div>
          </div>
          <div className="mtd-waste-grid">
            {monthToDateTopWaste.map((summary) => {
              const product = settings.products.find((candidate) => candidate.id === summary.productId);
              return (
                <div
                  className={`mtd-waste-card ${product ? `tone-${product.tone}` : 'no-data'}`}
                  key={summary.daypartId}
                >
                  <span>{summary.daypartLabel}</span>
                  <strong>{summary.productName || 'No waste logged'}</strong>
                  <span className="mtd-waste-cost">{formatMoney(summary.totalCost)}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {!testMode && (
        <section className="mtd-waste-summary" aria-labelledby="mtd-donations-title">
          <div className="section-heading activity-heading">
            <div>
              <p className="eyebrow">
                {monthToDateLabel} · Through today · Submitted donations · Estimated using current pricing
              </p>
              <h2 id="mtd-donations-title">Month-to-date top 3 waste items by donations</h2>
            </div>
          </div>
          {monthToDateTopDonations.length > 0 ? (
            <div className="mtd-waste-grid mtd-donation-grid">
              {monthToDateTopDonations.map((summary, index) => (
                <div className={`mtd-waste-card tone-${summary.tone}`} key={summary.donationItemId}>
                  <span>#{index + 1} donated waste</span>
                  <strong>{summary.donationItemName}</strong>
                  <span className="mtd-waste-cost">{formatMoney(summary.estimatedCost)}</span>
                  <span className="mtd-donation-quantity">
                    {formatQuantity(summary.totalAmount)} {summary.unit}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No priced donation submissions recorded this month.</div>
          )}
          <p className="footnote">
            Ranking includes donation items linked to configured products. Items without product pricing are not compared across pounds and individual counts.
          </p>
        </section>
      )}

      {nuggetPicker && (
        <IndividualNuggetPicker
          product={nuggetPicker}
          mode="cooldown"
          onClose={() => setNuggetPicker(null)}
          onSelect={(count) => void adjustWaste(nuggetPicker, count)}
        />
      )}
      {usageReviewDaypart && (
        <DaypartUsageReview
          daypartLabel={settings.dayparts.find((part) => part.id === usageReviewDaypart)?.label || usageReviewDaypart}
          busy={usageOutcomeBusy === usageReviewDaypart}
          onClose={() => {
            if (!usageOutcomeBusy) setUsageReviewDaypart(null);
          }}
          onSelect={(outcome) => void saveUsageOutcome(usageReviewDaypart, outcome)}
        />
      )}
    </section>
  );
}

function useProductCardPress({
  onAdd,
  onSubtract,
  onAdjustQuantity,
}: {
  onAdd: () => void;
  onSubtract: () => void;
  onAdjustQuantity?: (adjustment: number) => void;
}) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const pendingPress = useRef<{
    pointerId: number;
    startX: number;
    latestX: number;
  } | null>(null);
  const activeScrub = useRef<{
    pointerId: number;
    startX: number;
    adjustment: number;
  } | null>(null);
  const [holding, setHolding] = useState(false);
  const [scrubAdjustment, setScrubAdjustment] = useState<number | null>(null);

  const clearPressTimer = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => () => clearPressTimer(), []);

  const startPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || pendingPress.current) return;

    longPressed.current = false;
    setHolding(true);
    pendingPress.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      latestX: event.clientX,
    };

    if (onAdjustQuantity) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    timer.current = window.setTimeout(() => {
      const press = pendingPress.current;
      if (!press) return;

      longPressed.current = true;
      setHolding(false);

      if (onAdjustQuantity) {
        const adjustment = quantityAdjustmentFromDrag(press.latestX - press.startX);
        activeScrub.current = {
          pointerId: press.pointerId,
          startX: press.startX,
          adjustment,
        };
        setScrubAdjustment(adjustment);
        navigator.vibrate?.(30);
        return;
      }

      pendingPress.current = null;
      onSubtract();
      navigator.vibrate?.(40);
    }, onAdjustQuantity ? 450 : 650);
  };

  const movePress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pending = pendingPress.current;
    if (pending?.pointerId === event.pointerId) {
      pending.latestX = event.clientX;
    }

    const scrub = activeScrub.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;

    event.preventDefault();
    const adjustment = quantityAdjustmentFromDrag(event.clientX - scrub.startX);
    if (adjustment === scrub.adjustment) return;

    scrub.adjustment = adjustment;
    setScrubAdjustment(adjustment);
    navigator.vibrate?.(8);
  };

  const releasePointer = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const finishPress = (
    event: ReactPointerEvent<HTMLButtonElement>,
    releaseCapture: boolean,
  ) => {
    clearPressTimer();
    setHolding(false);
    pendingPress.current = null;
    const scrub = activeScrub.current;
    if (scrub?.pointerId === event.pointerId) {
      activeScrub.current = null;
      setScrubAdjustment(null);
      longPressed.current = true;
    }

    if (releaseCapture) releasePointer(event);

    if (scrub?.pointerId === event.pointerId && scrub.adjustment !== 0) {
      onAdjustQuantity?.(scrub.adjustment);
      navigator.vibrate?.(40);
    }
  };

  const endPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    finishPress(event, true);
  };

  const cancelPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    finishPress(event, true);
  };

  const lostPointerCapture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    finishPress(event, false);
  };

  const clickPress = () => {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    onAdd();
  };

  return {
    holding,
    scrubAdjustment,
    startPress,
    movePress,
    endPress,
    cancelPress,
    lostPointerCapture,
    clickPress,
  };
}

function QuantityScrubOverlay({
  adjustment,
  productName,
}: {
  adjustment: number;
  productName: string;
}) {
  const quantity = Math.abs(adjustment);
  const action = adjustment > 0 ? 'Add' : adjustment < 0 ? 'Subtract' : 'Choose quantity';
  const tone = adjustment > 0 ? ' is-adding' : adjustment < 0 ? ' is-subtracting' : '';

  return (
    <span className={`quantity-scrub-overlay${tone}`} aria-live="polite">
      <strong>{adjustment > 0 ? `+${quantity}` : adjustment < 0 ? `−${quantity}` : '0'}</strong>
      <span>
        {adjustment === 0
          ? action
          : `${action} ${quantity} · ${productName}`}
      </span>
      <small>Left subtracts · Right adds · Release to apply</small>
    </span>
  );
}

function ProductTrackingCard({
  product,
  variant = 'cooldown',
  primaryLabel,
  primaryValue,
  primaryEmpty = false,
  secondaryText,
  onAdd,
  onSubtract,
  onAdjustQuantity,
}: {
  product: ProductConfig;
  variant?: 'cooldown' | 'discard';
  primaryLabel: string;
  primaryValue: string;
  primaryEmpty?: boolean;
  secondaryText?: string;
  onAdd: () => void;
  onSubtract: () => void;
  onAdjustQuantity?: (adjustment: number) => void;
}) {
  const press = useProductCardPress({ onAdd, onSubtract, onAdjustQuantity });

  return (
    <button
      className={`waste-card${variant === 'discard' ? ' discard-card' : ''} tone-${product.tone}${press.holding ? ' is-holding' : ''}${onAdjustQuantity ? ' quantity-scrub-card' : ''}${press.scrubAdjustment !== null ? ' is-scrubbing' : ''}`}
      onPointerDown={press.startPress}
      onPointerMove={press.movePress}
      onPointerUp={press.endPress}
      onPointerCancel={press.cancelPress}
      onPointerLeave={onAdjustQuantity ? undefined : press.cancelPress}
      onLostPointerCapture={onAdjustQuantity ? press.lostPointerCapture : undefined}
      onContextMenu={(event) => event.preventDefault()}
      onClick={press.clickPress}
    >
      {press.scrubAdjustment !== null && (
        <QuantityScrubOverlay adjustment={press.scrubAdjustment} productName={product.name} />
      )}
      <span className="waste-card-top">
        <span className="waste-circle">{press.holding && !onAdjustQuantity ? '−' : '+'}</span>
        <span>{product.name} - {productTrackingPriceLabel(product)}</span>
      </span>
      <span className="waste-pan-label">{primaryLabel}</span>
      <span className={`waste-total${primaryEmpty ? ' empty' : ''}`}>{primaryValue}</span>
      {secondaryText && <span className="waste-daypart-total">{secondaryText}</span>}
      <span className="waste-hint">
        {onAdjustQuantity ? 'Tap +1 · Hold, slide left − / right +' : 'Tap to add · Hold to subtract'}
      </span>
    </button>
  );
}

function OperationalHeading({ eyebrow, title, effectiveMenu, menuSelection, setMenuSelection }: {
  eyebrow: string;
  title: string;
  effectiveMenu: MenuId;
  menuSelection: MenuSelection;
  setMenuSelection: (selection: MenuSelection) => void;
}) {
  return (
    <div className="section-heading">
      <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
      <label className="compact-control">
        Menu · overrides reset after 2 min idle
        <select value={menuSelection} onChange={(event) => setMenuSelection(event.target.value as MenuSelection)}>
          <option value="auto">Auto · {effectiveMenu === 'breakfast' ? 'Breakfast' : 'Lunch'}</option>
          <option value="breakfast">Breakfast override</option>
          <option value="lunch">Lunch override</option>
        </select>
      </label>
    </div>
  );
}

function DaypartWasteTarget({ label, cost, target, detail }: {
  label: string;
  cost: number;
  target: number;
  detail: string;
}) {
  return (
    <div className="stat-grid one">
      <Stat
        label={label}
        value={`${formatMoney(cost)} / ${formatMoney(target)}`}
        detail={detail}
        tone={cost - target > 0 ? 'danger' : undefined}
      />
    </div>
  );
}

function RecentProductActivity({ eyebrow, title, emptyText, entries, products, onUndo, undoDisabled }: {
  eyebrow: string;
  title: string;
  emptyText: string;
  entries: ReturnType<typeof mergeActivity>;
  products: ProductConfig[];
  onUndo: () => void;
  undoDisabled: boolean;
}) {
  return (
    <>
      <div className="section-heading activity-heading">
        <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
        <button className="secondary-button small" onClick={onUndo} disabled={undoDisabled}>
          <RotateCcw aria-hidden="true" /> Undo last
        </button>
      </div>
      <div className="activity-list">
        {entries.length === 0 && <EmptyState>{emptyText}</EmptyState>}
        {entries.slice(0, 12).map((entry) => {
          const product = products.find((candidate) => candidate.id === entry.productId);
          if (!product) return null;
          return (
            <div className="activity-row" key={entry.key}>
              <span className={`activity-dot tone-${product.tone}`} />
              <div>
                <strong>{displayProductQuantity(product, entry.equivalentUnits)} {product.name}</strong>
                <span>{entry.occurredAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {entry.deviceNames.join(', ')}</span>
              </div>
              <strong>{formatMoney(entry.cost)}</strong>
            </div>
          );
        })}
      </div>
    </>
  );
}

function UsageTab({ settings, currentDay, now, member, deviceName, notify }: {
  settings: AppSettings;
  currentDay: string;
  now: Date;
  member: MemberProfile;
  deviceName: string;
  notify: (message: string) => void;
}) {
  const latestCompletedDay = previousOperatingDayKey(currentDay);
  const monthStartDay = dayKey(new Date(now.getFullYear(), now.getMonth(), 1, 12));
  const [selectedDay, setSelectedDay] = useState(latestCompletedDay);
  const usageData = useUsageData(member.storeId, selectedDay);
  const monthToDateData = useUsageRangeData(member.storeId, monthStartDay, latestCompletedDay);
  const [outcomeBusy, setOutcomeBusy] = useState<DaypartId | null>(null);
  const [reviewDaypart, setReviewDaypart] = useState<DaypartId | null>(null);
  const recordUsageOutcome = useUsageOutcomeRecorder({ member, currentDay: selectedDay, deviceName, notify });

  useEffect(() => setSelectedDay(latestCompletedDay), [latestCompletedDay]);

  const usageScore = useMemo(() => usageData.donationRecord ? buildUsageScore({
    settings,
    selectedDayKey: selectedDay,
    now,
    currentWaste: usageData.currentWaste,
    previousWaste: usageData.currentWaste,
    donationPreviousWaste: usageData.currentWaste,
    donationCurrentWaste: usageData.donationDayWaste,
    donationRecord: usageData.donationRecord,
    usageRecord: usageData.record,
  }) : null, [now, selectedDay, settings, usageData.currentWaste, usageData.donationDayWaste, usageData.donationRecord, usageData.record]);
  const monthToDateUsage = useMemo(() => buildUsageRangeReport({
    settings,
    startDayKey: monthStartDay,
    endDayKey: latestCompletedDay,
    now,
    wasteEvents: monthToDateData.wasteEvents,
    donationRecords: monthToDateData.donationRecords,
    usageRecords: monthToDateData.usageRecords,
  }), [latestCompletedDay, monthStartDay, monthToDateData.donationRecords, monthToDateData.usageRecords, monthToDateData.wasteEvents, now, settings]);

  const saveDaypartUsageOutcome = async (daypartId: DaypartId, outcome: DaypartUsageOutcome) => {
    setOutcomeBusy(daypartId);
    const saved = await recordUsageOutcome(daypartId, outcome);
    setOutcomeBusy(null);
    if (saved) setReviewDaypart(null);
  };

  return (
    <section className="panel-stack">
      <MonthToDateUsagePanel
        report={monthToDateUsage}
        loading={monthToDateData.loading}
        error={monthToDateData.error}
        monthLabel={new Date(`${monthStartDay}T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })}
      />
      <UsageScorePanel
        score={usageScore}
        loading={usageData.loading}
        error={usageData.error}
        donationDayKey={usageData.donationDayKey}
        confirmationBusy={outcomeBusy}
        onReviewDaypart={setReviewDaypart}
        selectedDay={selectedDay}
        latestCompletedDay={latestCompletedDay}
        onSelectedDay={(day) => setSelectedDay(isOperatingDayKey(day) ? day : previousOperatingDayKey(day))}
      />
      {reviewDaypart && (
        <DaypartUsageReview
          daypartLabel={settings.dayparts.find((part) => part.id === reviewDaypart)?.label || reviewDaypart}
          busy={outcomeBusy === reviewDaypart}
          onClose={() => {
            if (!outcomeBusy) setReviewDaypart(null);
          }}
          onSelect={(outcome) => void saveDaypartUsageOutcome(reviewDaypart, outcome)}
        />
      )}
    </section>
  );
}

function MonthToDateUsagePanel({ report, loading, error, monthLabel }: {
  report: ReturnType<typeof buildUsageRangeReport>;
  loading: boolean;
  error: string;
  monthLabel: string;
}) {
  const status = report.reportEligible ? 'reliable' : report.score === null ? 'provisional' : 'unreliable';
  return (
    <section className="usage-score-section" aria-labelledby="mtd-usage-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{monthLabel} · Completed operating days only</p>
          <h2 id="mtd-usage-title">Month-to-date usage</h2>
        </div>
      </div>
      {error && <div className="error-banner" role="alert">Month-to-date usage could not sync: {error}</div>}
      {loading ? (
        <EmptyState>Loading month-to-date usage…</EmptyState>
      ) : (
        <div className={`usage-score-hero status-${status}`}>
          <div className="usage-score-number">
            <strong>{report.score === null ? '—' : report.score}</strong>
            <span>/ 100</span>
          </div>
          <div>
            <strong>Running MTD average</strong>
            <span>{report.scoredDays} scored day{report.scoredDays === 1 ? '' : 's'} · {report.pendingDays} awaiting donation</span>
          </div>
          <span className="usage-eligibility-badge">
            {report.reportEligible ? <Check aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
            {report.confidence}
          </span>
        </div>
      )}
    </section>
  );
}

function UsageScorePanel({ score, loading, error, donationDayKey, confirmationBusy, onReviewDaypart, selectedDay, latestCompletedDay, onSelectedDay }: {
  score: ReturnType<typeof buildUsageScore> | null;
  loading: boolean;
  error: string;
  donationDayKey: string;
  confirmationBusy: DaypartId | null;
  onReviewDaypart: (daypartId: DaypartId) => void;
  selectedDay: string;
  latestCompletedDay: string;
  onSelectedDay: (selectedDay: string) => void;
}) {
  const statusLabel = score?.status === 'reliable'
    ? 'Reliable for reporting'
    : score?.status === 'provisional'
      ? 'Provisional · donation pending'
      : score?.status === 'caution'
        ? 'Caution · potentially incomplete'
        : 'Unreliable · exclude from trends';

  return (
    <section className="usage-score-section" aria-labelledby="usage-score-title">
      <div className="section-heading activity-heading usage-score-heading">
        <div>
          <p className="eyebrow">One day at a time · Continuity · Donation reconciliation</p>
          <h2 id="usage-score-title">Daily system usage</h2>
        </div>
        <label className="compact-control usage-date-control">
          Usage date
          <input
            type="date"
            value={selectedDay}
            max={latestCompletedDay}
            onChange={(event) => {
              if (event.target.value) onSelectedDay(event.target.value);
            }}
          />
        </label>
      </div>
      {error && <div className="error-banner" role="alert">Usage evidence could not sync: {error}</div>}
      {loading ? (
        <EmptyState>Loading system usage evidence…</EmptyState>
      ) : !score ? (
        <EmptyState>
          Awaiting the {new Date(`${donationDayKey}T12:00:00`).toLocaleDateString([], {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
          })} donation submission. No usage result is shown until that count is saved.
        </EmptyState>
      ) : (
        <>
          <div className={`usage-score-hero status-${score.status}`}>
            <div className="usage-score-number">
              <strong>{score.score}</strong>
              <span>/ 100</span>
            </div>
            <div>
              <strong>{statusLabel}</strong>
              <span>Minimum reliable score: {score.minimumRequired}</span>
            </div>
            <span className="usage-eligibility-badge">
              {score.reportEligible ? <Check aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
              {score.reportEligible ? RELIABLE_USAGE_LABEL : INSUFFICIENT_USAGE_LABEL}
            </span>
          </div>

          <div className="usage-component-grid">
            <Stat
              label="Cool Down presence"
              value={score.coverageScore === null ? 'Not measured' : `${score.coverageScore}%`}
              detail={score.presenceMeasured
                ? '15-minute visible-page checks · 45% of score'
                : 'Scoring began Aug 15, 2026 · excluded from this day'}
            />
            <Stat label="Logging continuity" value={`${score.continuityScore}%`} detail="Unexplained three-hour gaps · 25% of score" />
            <Stat
              label="Donation reconciliation"
              value={score.donationScore === null ? 'Pending' : `${score.donationScore}%`}
              detail="25% weight tolerance · 30% of score"
              tone={score.donationScore !== null && score.donationScore < 80 ? 'danger' : undefined}
            />
          </div>

          <div className="usage-daypart-grid">
            {score.dayparts.map((daypart) => (
              <article className={`usage-daypart-card${daypart.needsUsageReview ? ' needs-confirmation' : ''}${daypart.missedWaste || daypart.uncertainWaste ? ' usage-failed' : ''}`} key={daypart.daypartId}>
                <div>
                  <span>{daypart.label}</span>
                  <strong>{daypart.score}</strong>
                </div>
                <small>{daypart.presenceMeasured
                  ? `${daypart.activeSlots}/${daypart.expectedSlots} presence checks · ${daypart.eventCount} entries`
                  : `Presence not measured · ${daypart.eventCount} entries`}</small>
                {daypart.confirmedZeroWaste && <span className="usage-confirmed"><Check aria-hidden="true" /> Zero waste confirmed</span>}
                {daypart.missedWaste && <span className="usage-outcome-failed"><AlertTriangle aria-hidden="true" /> Waste was not logged</span>}
                {daypart.uncertainWaste && <span className="usage-outcome-failed"><AlertTriangle aria-hidden="true" /> Accuracy is uncertain</span>}
                {daypart.completed && daypart.eventCount === 0 && (
                  <button
                    className="secondary-button small"
                    disabled={confirmationBusy !== null}
                    onClick={() => onReviewDaypart(daypart.daypartId)}
                  >
                    <Check aria-hidden="true" /> {confirmationBusy === daypart.daypartId
                      ? 'Saving…'
                      : daypart.needsUsageReview ? 'Review empty daypart' : 'Update response'}
                  </button>
                )}
              </article>
            ))}
          </div>

          <details className="usage-score-details">
            <summary>Why this score?</summary>
            <ul>{score.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            <p>This day is finalized by the next operating day’s donation submission. Saturday is finalized Monday because Sunday is excluded. Direct discard is intentionally excluded.</p>
          </details>
        </>
      )}
    </section>
  );
}

function DaypartUsageReview({ daypartLabel, busy, onClose, onSelect }: {
  daypartLabel: string;
  busy: boolean;
  onClose: () => void;
  onSelect: (outcome: DaypartUsageOutcome) => void;
}) {
  return (
    <Modal title={`Review ${daypartLabel}`} icon={<AlertTriangle />} onClose={onClose}>
      <p>Nothing was logged for {daypartLabel}. What happened?</p>
      <div className="usage-review-options">
        <button className="primary-button" disabled={busy} onClick={() => onSelect('zero-waste')}>
          <Check aria-hidden="true" /> No Cool Down waste occurred
        </button>
        <button className="secondary-button usage-missed-button" disabled={busy} onClick={() => onSelect('missed-waste')}>
          <AlertTriangle aria-hidden="true" /> Waste occurred but wasn’t logged
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => onSelect('uncertain')}>
          Not sure
        </button>
      </div>
      <p className="usage-review-note">Missed or uncertain waste is recorded as a usage issue. It does not add an estimated quantity to waste totals.</p>
    </Modal>
  );
}

function IndividualNuggetPicker({ product, mode, onClose, onSelect }: {
  product: ProductConfig;
  mode: 'cooldown' | 'discard';
  onClose: () => void;
  onSelect: (count: number) => void;
}) {
  const discarded = mode === 'discard';
  return (
    <Modal title={discarded ? 'Add individual discarded nuggets' : 'Add individual nuggets'} onClose={onClose}>
      <p>{discarded
        ? 'Choose how many individual nuggets went directly to trash.'
        : `Choose how many individual nuggets to add. ${product.unitsPerCup || 14} nuggets equals one cup.`}</p>
      <div className="number-grid">
        {Array.from({ length: Math.max(1, (product.unitsPerCup || 14) - 1) }, (_, index) => index + 1).map((count) => (
          <button key={count} onClick={() => {
            onSelect(count);
            onClose();
          }}>{count}</button>
        ))}
      </div>
    </Modal>
  );
}

function DiscardTab({
  settings,
  events,
  coolDownEvents,
  member,
  deviceName,
  effectiveMenu,
  menuSelection,
  setMenuSelection,
  targetDaypartId,
  warningMutedUntil,
  showWarning,
  notify,
}: {
  settings: AppSettings;
  events: DiscardEvent[];
  coolDownEvents: WasteEvent[];
  member: MemberProfile;
  deviceName: string;
  effectiveMenu: MenuId;
  menuSelection: MenuSelection;
  setMenuSelection: (selection: MenuSelection) => void;
  targetDaypartId: DaypartId;
  warningMutedUntil: number;
  showWarning: (warning: { daypart: string; total: number; target: number }) => void;
  notify: (message: string) => void;
}) {
  const [nuggetPicker, setNuggetPicker] = useState<ProductConfig | null>(null);
  const products = settings.products.filter((product) => product.menus.includes(effectiveMenu));
  const daypart = settings.dayparts.find((candidate) => candidate.id === targetDaypartId)!;
  const menuEvents = events.filter((event) => event.menu === effectiveMenu);
  const activeEvents = menuEvents.filter((event) => event.daypartId === targetDaypartId);
  const coolDownDaypartEvents = coolDownEvents.filter((event) => event.daypartId === targetDaypartId);
  const combinedDaypartEvents = [...coolDownDaypartEvents, ...activeEvents];
  const activeWaste = daypartWaste(combinedDaypartEvents, targetDaypartId);
  const merged = mergeActivity(menuEvents, settings.products);
  const targetVariance = activeWaste.cost - daypart.totalDollarTarget;
  const varianceDetail = Math.abs(targetVariance) < 0.005
    ? 'On target'
    : `${formatMoney(Math.abs(targetVariance))} ${targetVariance > 0 ? 'over' : 'under'} target`;

  const adjustDiscard = async (product: ProductConfig, equivalentUnits: number) => {
    const isCup = product.trackingUnit === 'cup' && Math.abs(equivalentUnits) === (product.unitsPerCup || 14);
    const eventData: Omit<DiscardEvent, 'id' | 'eventAt'> = {
      storeId: member.storeId,
      productId: product.id,
      productName: product.name,
      equivalentUnits,
      displayQuantity: isCup ? Math.sign(equivalentUnits) : equivalentUnits,
      displayUnit: isCup ? 'cup' : 'each',
      unitCostSnapshot: product.unitCost,
      dayKey: dayKey(),
      daypartId: targetDaypartId,
      menu: effectiveMenu,
      deviceName,
      createdBy: member.uid,
      createdByName: member.displayName,
      reason: 'other',
      reasonDetail: '',
    };

    try {
      await confirmWrite(createDiscardEvent(eventData));
      const projectedCost = activeWaste.cost + equivalentUnits * product.unitCost;
      if (projectedCost > daypart.totalDollarTarget && Date.now() >= warningMutedUntil) {
        showWarning({ daypart: daypart.label, total: projectedCost, target: daypart.totalDollarTarget });
      }
    } catch (caught) {
      notify(errorMessage(caught));
    }
  };

  const subtractDiscard = (
    product: ProductConfig,
    totalUnits: number,
    requestedQuantity = product.tapQuantity,
  ) => {
    if (totalUnits <= 0) {
      notify(`No ${product.name} discard entry to subtract.`);
      return;
    }
    void adjustDiscard(product, -Math.min(requestedQuantity, totalUnits));
  };

  const undoLast = async () => {
    const latest = events.find((event) => event.createdBy === member.uid);
    if (!latest) return;
    try {
      await removeDiscardEvents(member.storeId, [latest.id]);
      notify('Last discard entry removed.');
    } catch (caught) {
      notify(errorMessage(caught));
    }
  };

  return (
    <section className="panel-stack">
      <OperationalHeading
        eyebrow={`${daypart.label} · Direct to trash · Returns to Cool Down after 45 seconds idle`}
        title="Log product that skips cool down"
        effectiveMenu={effectiveMenu}
        menuSelection={menuSelection}
        setMenuSelection={setMenuSelection}
      />

      <DaypartWasteTarget
        label={`${daypart.label} waste / target`}
        cost={activeWaste.cost}
        target={daypart.totalDollarTarget}
        detail={`${varianceDetail} · Cool Down + discard`}
      />

      <div>
        <p className="discard-step-label">Tap each product sent directly to trash</p>
        <div className="waste-grid">
          {products.map((product) => {
            const totals = productWaste(activeEvents, product.id);
            return (
              <div className="waste-card-wrap" key={product.id}>
                <ProductTrackingCard
                  product={product}
                  variant="discard"
                  primaryLabel="Daypart direct discard"
                  primaryValue={displayProductQuantity(product, totals.units)}
                  onAdd={() => void adjustDiscard(product, product.tapQuantity)}
                  onSubtract={() => subtractDiscard(product, totals.units)}
                  onAdjustQuantity={settings.cardScrubEnabled
                    ? (adjustment) => {
                      if (adjustment > 0) {
                        void adjustDiscard(product, adjustment);
                      } else if (adjustment < 0) {
                        subtractDiscard(product, totals.units, Math.abs(adjustment));
                      }
                    }
                    : undefined}
                />
                {product.trackingUnit === 'cup' && !settings.cardScrubEnabled && (
                  <button
                    className="individual-nuggets-button"
                    onClick={() => setNuggetPicker(product)}
                  >
                    Add individual nuggets
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <RecentProductActivity
        eyebrow="Merged by product and minute"
        title="Recent discard activity"
        emptyText="No direct discard logged for this menu yet."
        entries={merged}
        products={settings.products}
        onUndo={undoLast}
        undoDisabled={!events.some((event) => event.createdBy === member.uid)}
      />

      {nuggetPicker && (
        <IndividualNuggetPicker
          product={nuggetPicker}
          mode="discard"
          onClose={() => setNuggetPicker(null)}
          onSelect={(count) => void adjustDiscard(nuggetPicker, count)}
        />
      )}
    </section>
  );
}

function SosTab({ settings, entries, member, deviceName, today, initialDaypartId, notify }: {
  settings: AppSettings;
  entries: SosEntry[];
  member: MemberProfile;
  deviceName: string;
  today: string;
  initialDaypartId: DaypartId;
  notify: (message: string) => void;
}) {
  const [selectedDaypart, setSelectedDaypart] = useState<DaypartId>(initialDaypartId);
  const [average, setAverage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const daypartEntries = entries.filter((entry) => entry.daypartId);
  const averageEntries = daypartEntries.length ? daypartEntries : entries;
  const sortedEntries = [...entries].sort((a, b) => {
    const aIndex = a.daypartId ? settings.dayparts.findIndex((part) => part.id === a.daypartId) : 99;
    const bIndex = b.daypartId ? settings.dayparts.findIndex((part) => part.id === b.daypartId) : 99;
    return aIndex - bIndex || (a.hourStart ?? 99) - (b.hourStart ?? 99);
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const seconds = parseDuration(average);
    if (seconds === null) {
      setError('Enter the daypart average as minutes:seconds, such as 4:18.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveSosEntry({
        storeId: member.storeId,
        dayKey: today,
        daypartId: selectedDaypart,
        averageSeconds: seconds,
        createdBy: member.uid,
        createdByName: member.displayName,
        deviceName,
      });
      setAverage('');
      notify('Daypart SOS average saved.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const todayAverage = averageEntries.length
    ? averageEntries.reduce((sum, entry) => sum + entry.averageSeconds, 0) / averageEntries.length
    : 0;
  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div><p className="eyebrow">Manual daypart entry</p><h2>Speed of service</h2></div>
      </div>
      <div className="stat-grid two">
        <Stat label="Dayparts logged" value={String(daypartEntries.length)} detail="One average per daypart" />
        <Stat label="Today’s average" value={averageEntries.length ? formatDuration(todayAverage) : '—'} detail="Minutes:seconds" />
      </div>
      <form className="entry-form" onSubmit={submit}>
        <label>
          Daypart
          <select value={selectedDaypart} onChange={(event) => setSelectedDaypart(event.target.value as DaypartId)}>
            {settings.dayparts.map((part) => (
              <option key={part.id} value={part.id}>{part.label}</option>
            ))}
          </select>
        </label>
        <label>
          Reported average
          <input
            inputMode="numeric"
            placeholder="4:18"
            value={average}
            onChange={(event) => setAverage(formatDurationInput(event.target.value))}
            required
          />
        </label>
        <button className="primary-button" disabled={busy}><Save aria-hidden="true" /> {busy ? 'Saving…' : 'Save daypart'}</button>
        {error && <p className="form-error full-row" role="alert">{error}</p>}
      </form>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th>Daypart</th><th>Average</th><th>Logged by</th><th>Device</th></tr></thead>
          <tbody>
            {sortedEntries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.daypartId
                  ? settings.dayparts.find((part) => part.id === entry.daypartId)?.label || entry.daypartId
                  : `Legacy · ${formatHourRange(entry.hourStart ?? 0)}`}</td>
                <td><strong>{formatDuration(entry.averageSeconds)}</strong></td>
                <td>{entry.createdByName}</td>
                <td>{entry.deviceName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <EmptyState>No daypart SOS averages logged today.</EmptyState>}
      </div>
    </section>
  );
}

function DonationsTab({ settings, member, currentDay, notify }: {
  settings: AppSettings;
  member: MemberProfile;
  currentDay: string;
  notify: (message: string) => void;
}) {
  const [selectedDay, setSelectedDay] = useState(currentDay);
  const dayData = useDonationDayData(member.storeId, selectedDay);
  const existing = dayData.record;
  const livePredictions = useMemo(() => Object.fromEntries(settings.donationItems.map((item) => [
    item.id,
    donationPrediction(item, settings, dayData.previousWaste, dayData.currentWaste),
  ])), [settings, dayData.previousWaste, dayData.currentWaste]);
  const predictions = existing?.predictions || livePredictions;
  const [actuals, setActuals] = useState<Record<string, number>>({});
  const [addedAmounts, setAddedAmounts] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);

  useEffect(() => {
    if (dayData.loading || dayData.error) return;
    setActuals(existing?.actuals || Object.fromEntries(settings.donationItems.map((item) => [item.id, 0])));
    setAddedAmounts(Object.fromEntries(settings.donationItems.map((item) => [item.id, 0])));
    setEditing(!existing);
    setSubmitOpen(false);
  }, [dayData.loading, dayData.error, existing, settings.donationItems, selectedDay]);

  const selectedDayLabel = formatDayKeyLabel(selectedDay);
  const submittedActuals = existing
    ? Object.fromEntries(settings.donationItems.map((item) => [
      item.id,
      (actuals[item.id] || 0) + (addedAmounts[item.id] || 0),
    ]))
    : actuals;
  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Final donation totals by date</p>
          <h2>Donation counts</h2>
        </div>
        <div className="donation-date-panel">
          <label className="compact-control donation-date-control">
            Donation date
            <input
              type="date"
              value={selectedDay}
              max={currentDay}
              onChange={(event) => setSelectedDay(event.target.value || currentDay)}
            />
          </label>
          {existing && <span className="status-badge"><Check aria-hidden="true" /> Submitted · revision {existing.revision}</span>}
        </div>
      </div>
      <AlarmMutedNotice page="Donations" />
      <div className="donation-replacement-warning" role="note">
        <AlertTriangle aria-hidden="true" />
        <div>
          <strong>{existing ? `Review the saved totals and enter any new donation amounts for ${selectedDayLabel}.` : `Enter the complete total for ${selectedDayLabel}.`}</strong>
          <span>{existing
            ? 'You can correct a saved total if needed. The system adds the new amount and stores the calculated updated total for that date.'
            : 'If this date is updated later, the system will show the saved amounts and do the addition for you.'}</span>
        </div>
      </div>
      {dayData.error ? (
        <div className="error-banner" role="alert">{dayData.error}</div>
      ) : dayData.loading ? (
        <EmptyState>Loading donation totals for {selectedDayLabel}…</EmptyState>
      ) : (
        <>
          <div className="donation-toolbar">
            <span>{editing
              ? existing
                ? 'Correct a saved total if needed, then enter only what was added. The updated total is calculated automatically.'
                : 'Enter weights right to left: 1, 2, 3 becomes 1.23 lb.'
              : `Final total entered by ${existing?.initials || ''}`}</span>
            {!editing && (
              <div><button className="secondary-button small" onClick={() => setEditing(true)}><RotateCcw /> Revise this date’s total</button></div>
            )}
          </div>
          <div className="data-table-wrap">
            <table className={`data-table donation-table${existing ? ' donation-revision-table' : ''}`}>
              <thead>
                {existing ? (
                  <tr><th>Donation item</th><th>Unit</th><th>Saved total</th><th>Amount to add</th><th>New total</th></tr>
                ) : (
                  <tr><th>Donation item</th><th>Unit</th><th>Total donated</th></tr>
                )}
              </thead>
              <tbody>
                {settings.donationItems.map((item) => {
                  const actual = actuals[item.id] || 0;
                  const savedAmount = actuals[item.id] || 0;
                  const addedAmount = addedAmounts[item.id] || 0;
                  const formatAmount = (amount: number) => (
                    item.unit === 'lb' ? amount.toFixed(2) : formatQuantity(amount)
                  );
                  return (
                    <tr key={item.id}>
                      <td><strong>{item.name}</strong></td>
                      <td>{item.unit === 'lb' ? 'Lbs' : 'Each'}</td>
                      {existing ? (
                        <>
                          <td>
                            <input
                              className="table-input donation-entry-input donation-saved-input"
                              type="text"
                              inputMode="numeric"
                              value={formatAmount(savedAmount)}
                              disabled={!editing}
                              aria-label={`${item.name} saved ${item.unit === 'lb' ? 'pounds' : 'count'}`}
                              onFocus={(event) => event.currentTarget.select()}
                              onClick={(event) => event.currentTarget.select()}
                              onChange={(event) => setActuals((current) => ({
                                ...current,
                                [item.id]: parseDonationEntry(event.target.value, item.unit),
                              }))}
                            />
                          </td>
                          <td>
                            <input
                              className="table-input donation-entry-input donation-added-input"
                              type="text"
                              inputMode="numeric"
                              value={formatAmount(addedAmount)}
                              disabled={!editing}
                              aria-label={`${item.name} additional ${item.unit === 'lb' ? 'pounds' : 'count'}`}
                              onFocus={(event) => event.currentTarget.select()}
                              onClick={(event) => event.currentTarget.select()}
                              onChange={(event) => setAddedAmounts((current) => ({
                                ...current,
                                [item.id]: parseDonationEntry(event.target.value, item.unit),
                              }))}
                            />
                          </td>
                          <td><strong className="calculated-value donation-new-value">{formatAmount(savedAmount + addedAmount)}</strong></td>
                        </>
                      ) : (
                        <td>
                          <input
                            className="table-input donation-entry-input"
                            type="text"
                            inputMode="numeric"
                            value={formatAmount(actual)}
                            disabled={!editing}
                            aria-label={`${item.name} donated ${item.unit === 'lb' ? 'pounds' : 'count'}`}
                            onFocus={(event) => event.currentTarget.select()}
                            onClick={(event) => event.currentTarget.select()}
                            onChange={(event) => setActuals((current) => ({
                              ...current,
                              [item.id]: parseDonationEntry(event.target.value, item.unit),
                            }))}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {editing && <button className="primary-button submit-day" onClick={() => setSubmitOpen(true)}>{existing ? 'Save updated totals' : 'Save this date’s total'} <ChevronRight /></button>}
          {submitOpen && (
            <DonationSubmit
              existing={existing}
              dayLabel={selectedDayLabel}
              onClose={() => setSubmitOpen(false)}
              onSubmit={async (initials) => {
                const variance = Object.fromEntries(settings.donationItems.map((item) => {
                  const predicted = predictions[item.id];
                  return [item.id, predicted === null ? null : (submittedActuals[item.id] || 0) - predicted];
                }));
                await saveDonationRecord({
                  storeId: member.storeId,
                  dayKey: selectedDay,
                  actuals: submittedActuals,
                  predictions,
                  units: Object.fromEntries(settings.donationItems.map((item) => [item.id, item.unit])),
                  variance,
                  initials,
                  submittedBy: member.uid,
                  submittedByName: member.displayName,
                  revision: (existing?.revision || 0) + 1,
                });
                setSubmitOpen(false);
                setEditing(false);
                notify(existing
                  ? `Updated donation totals saved for ${selectedDayLabel}.`
                  : `Donation totals for ${selectedDayLabel} saved.`);
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function DonationSubmit({ existing, dayLabel, onClose, onSubmit }: {
  existing: DonationRecord | null;
  dayLabel: string;
  onClose: () => void;
  onSubmit: (initials: string) => Promise<void>;
}) {
  const [initials, setInitials] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = initials.trim().toUpperCase();
    if (!/^[A-Z]{2,5}$/.test(normalized)) {
      setError('Enter 2–5 letters.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(normalized);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  };
  return (
    <Modal title={existing ? 'Save updated donation count' : 'Submit final donation count'} onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <p>{existing
          ? `Any corrected saved totals and added amounts will be combined for ${dayLabel}. The calculated updated totals will replace that date’s saved record.`
          : `This creates one final donation record for ${dayLabel}.`}</p>
        <label>Initials<input autoFocus maxLength={5} value={initials} onChange={(event) => setInitials(event.target.value.toUpperCase())} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : existing ? 'Save updated totals' : 'Save final count'}</button>
      </form>
    </Modal>
  );
}

function AdminTab({ settings, member, deviceName, testDaypartEnabled, setTestDaypartEnabled, notify, onDirtyChange }: {
  settings: AppSettings;
  member: MemberProfile;
  deviceName: string;
  testDaypartEnabled: boolean;
  setTestDaypartEnabled: (enabled: boolean) => void;
  notify: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const storeId = member.storeId;
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [selectedDaypart, setSelectedDaypart] = useState<DaypartId>('breakfast');
  const [saving, setSaving] = useState(false);
  const [device, setDevice] = useState(deviceName);
  const [savedSettingsSignature, setSavedSettingsSignature] = useState(() => JSON.stringify(settings));
  const [savedDevice, setSavedDevice] = useState(deviceName);
  const [exportStartDate, setExportStartDate] = useState(dayKey());
  const [exportEndDate, setExportEndDate] = useState(dayKey());
  const [exportPeriod, setExportPeriod] = useState<ExportPeriod>(1);
  const [exportGrouping, setExportGrouping] = useState<WasteExportGrouping>('hour');
  const [exportMetric, setExportMetric] = useState<'cost' | 'quantity'>('cost');
  const [exporting, setExporting] = useState(false);
  const [exportingDonations, setExportingDonations] = useState(false);
  const [exportSource, setExportSource] = useState<'live' | 'demo'>('live');
  const [changingDemoData, setChangingDemoData] = useState(false);

  useEffect(() => {
    setDraft(structuredClone(settings));
    setSavedSettingsSignature(JSON.stringify(settings));
  }, [settings]);

  const hasUnsavedChanges = JSON.stringify(draft) !== savedSettingsSignature || device !== savedDevice;

  useEffect(() => {
    onDirtyChange(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const daypartIndex = draft.dayparts.findIndex((part) => part.id === selectedDaypart);
  const daypart = draft.dayparts[daypartIndex];
  const products = draft.products.filter((product) => product.menus.includes(daypart.menu));
  const calculatedDaypartTarget = products.reduce((total, product) => (
    total + targetDollarForProduct(product, daypart.productTargetQuantities[product.id] || 0)
  ), 0);
  const dailyCasesForProduct = (product: ProductConfig) => {
    if (!product.caseWeightLb || product.caseWeightLb <= 0) return null;
    return draft.dayparts.reduce((total, part) => (
      total + (targetCasesForProduct(product, part.productTargetQuantities[product.id] || 0) || 0)
    ), 0);
  };

  const updateProduct = (productId: string, patch: Partial<ProductConfig>) => {
    setDraft((current) => {
      const nextProducts = current.products.map((product) => (
        product.id === productId
          ? withDerivedProductPricing({ ...product, ...patch })
          : product
      ));
      return {
        ...current,
        products: nextProducts,
        dayparts: current.dayparts.map((part) => ({
          ...part,
          totalDollarTarget: nextProducts
            .filter((product) => product.menus.includes(part.menu))
            .reduce((total, product) => total + targetDollarForProduct(product, part.productTargetQuantities[product.id] || 0), 0),
        })),
      };
    });
  };
  const updateQuantity = (productId: string, quantity: number) => {
    setDraft((current) => ({
      ...current,
      dayparts: current.dayparts.map((part) => {
        if (part.id !== selectedDaypart) return part;
        const productTargetQuantities = {
          ...part.productTargetQuantities,
          [productId]: Math.max(0, quantity),
        };
        const totalDollarTarget = current.products
          .filter((product) => product.menus.includes(part.menu))
          .reduce((total, product) => total + targetDollarForProduct(product, productTargetQuantities[product.id] || 0), 0);
        return { ...part, productTargetQuantities, totalDollarTarget };
      }),
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const settingsToSave = {
        ...draft,
        products: draft.products.map(withDerivedProductPricing),
      };
      await saveSettings(storeId, settingsToSave);
      if (!settingsToSave.cooldownTimersEnabled) await resetAllCooldownTimers(storeId);
      localStorage.setItem('waste-sos-device-name', device.trim() || 'Web device');
      setDraft(settingsToSave);
      setSavedSettingsSignature(JSON.stringify(settingsToSave));
      setSavedDevice(device);
      onDirtyChange(false);
      notify('Admin settings saved for every device.');
    } catch (caught) {
      notify(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const updateExportDates = (period: ExportPeriod, endingDate: string) => {
    setExportPeriod(period);
    if (period === 'custom') {
      setExportEndDate(endingDate);
      return;
    }
    if (!endingDate) {
      setExportStartDate('');
      setExportEndDate('');
      return;
    }
    if (typeof period === 'string') {
      const range = wasteExportPresetRange(period, endingDate);
      setExportStartDate(range.startDayKey);
      setExportEndDate(range.endDayKey);
      return;
    }
    setExportEndDate(endingDate);
    const startDate = new Date(`${endingDate}T12:00:00`);
    startDate.setDate(startDate.getDate() - (period - 1));
    setExportStartDate(dayKey(startDate));
  };

  const selectedExportDays = (operatingDaysOnly = false) => {
    const start = Date.parse(`${exportStartDate}T00:00:00Z`);
    const end = Date.parse(`${exportEndDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
    if (operatingDaysOnly) return operatingDayCount(exportStartDate, exportEndDate);
    return Math.round((end - start) / 86_400_000) + 1;
  };

  const loadUsageReportForExport = async () => {
    const extendedEndDay = nextOperatingDayKey(exportEndDate);
    const [wasteEvents, donationRecords, usageRecords] = await Promise.all([
      exportSource === 'demo'
        ? loadDemoWasteForDateRange(storeId, exportStartDate, extendedEndDay)
        : loadWasteForDateRange(storeId, exportStartDate, extendedEndDay),
      exportSource === 'demo'
        ? loadDemoDonationRecordsForDateRange(storeId, exportStartDate, extendedEndDay)
        : loadDonationRecordsForDateRange(storeId, exportStartDate, extendedEndDay),
      exportSource === 'demo'
        ? Promise.resolve([])
        : loadUsageDaysForDateRange(storeId, exportStartDate, exportEndDate),
    ]);
    return buildUsageRangeReport({
      settings: draft,
      startDayKey: exportStartDate,
      endDayKey: exportEndDate,
      now: new Date(),
      wasteEvents,
      donationRecords,
      usageRecords,
    });
  };

  const exportWaste = async () => {
    setExporting(true);
    try {
      const exportDays = selectedExportDays(true);
      if (!exportDays) {
        notify('Choose a range containing at least one Monday–Saturday operating day.');
        return;
      }
      const loadedEvents = exportSource === 'demo'
        ? await loadDemoWasteForDateRange(storeId, exportStartDate, exportEndDate)
        : await loadWasteForDateRange(storeId, exportStartDate, exportEndDate);
      const events = loadedEvents.filter((event) => isOperatingDayKey(event.dayKey));
      if (events.length === 0) {
        notify(`No Monday–Saturday cool down data was found from ${exportStartDate} through ${exportEndDate}.`);
        return;
      }
      const trend = buildWasteTrend(events, draft, exportGrouping);
      const usageReport = await loadUsageReportForExport();
      const workbook = await createWasteTrendWorkbook({
        events,
        trend,
        settings: draft,
        grouping: exportGrouping,
        startDayKey: exportStartDate,
        endDayKey: exportEndDate,
        source: exportSource,
        metric: exportMetric,
        usageReport,
      });
      const url = URL.createObjectURL(new Blob([workbook], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const link = document.createElement('a');
      link.href = url;
      const sourcePrefix = exportSource === 'demo' ? 'demo-' : '';
      link.download = exportDays === 1
        ? `${sourcePrefix}cool-down-${exportEndDate}-by-${exportGrouping}-${exportMetric}.xlsx`
        : `${sourcePrefix}cool-down-${exportDays}-operating-days-ending-${exportEndDate}-by-${exportGrouping}-${exportMetric}.xlsx`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      notify(`${exportDays}-operating-day cool down export downloaded.`);
    } catch (caught) {
      notify(errorMessage(caught));
    } finally {
      setExporting(false);
    }
  };

  const exportDonations = async () => {
    setExportingDonations(true);
    try {
      const exportDays = selectedExportDays();
      if (!exportDays) {
        notify('Choose a starting date that is on or before the ending date.');
        return;
      }
      const records = exportSource === 'demo'
        ? await loadDemoDonationRecordsForDateRange(storeId, exportStartDate, exportEndDate)
        : await loadDonationRecordsForDateRange(storeId, exportStartDate, exportEndDate);
      if (records.length === 0) {
        notify(`No submitted donation data was found from ${exportStartDate} through ${exportEndDate}.`);
        return;
      }
      const usageReport = await loadUsageReportForExport();
      const workbook = await createDonationWorkbook({
        records,
        settings: draft,
        startDayKey: exportStartDate,
        endDayKey: exportEndDate,
        source: exportSource,
        usageReport,
      });
      const url = URL.createObjectURL(new Blob([workbook], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const link = document.createElement('a');
      link.href = url;
      const sourcePrefix = exportSource === 'demo' ? 'demo-' : '';
      link.download = exportDays === 1
        ? `${sourcePrefix}donations-${exportEndDate}.xlsx`
        : `${sourcePrefix}donations-${exportDays}-days-ending-${exportEndDate}.xlsx`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      notify(`${exportDays}-day donation export downloaded.`);
    } catch (caught) {
      notify(errorMessage(caught));
    } finally {
      setExportingDonations(false);
    }
  };

  const seedDemoData = async () => {
    setChangingDemoData(true);
    try {
      await seedExportDemoData(storeId, draft, member.uid, member.displayName, device);
      setExportSource('demo');
      updateExportDates(30, dayKey());
      notify('Demo export data seeded for the current 30 days.');
    } catch (caught) {
      notify(errorMessage(caught));
    } finally {
      setChangingDemoData(false);
    }
  };

  const removeDemoData = async () => {
    if (!window.confirm('Remove all demo export data? Live data will not be affected.')) return;
    setChangingDemoData(true);
    try {
      await removeExportDemoData(storeId);
      setExportSource('live');
      notify('All isolated demo export data was removed.');
    } catch (caught) {
      notify(errorMessage(caught));
    } finally {
      setChangingDemoData(false);
    }
  };

  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div><p className="eyebrow">Protected settings</p><h2>Targets, costs, and weights</h2></div>
        <button className="primary-button" onClick={save} disabled={saving}><Save /> {saving ? 'Saving…' : 'Save all changes'}</button>
      </div>
      <AlarmMutedNotice page="Admin" timeout="2 minutes" />
      <div className="admin-strip">
        <label>This device name<input value={device} onChange={(event) => setDevice(event.target.value)} /></label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={draft.cooldownTimersEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              cooldownTimersEnabled: event.target.checked,
            }))}
          />
          <span>Enable one-hour cooldown pan timers</span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={draft.sosEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              sosEnabled: event.target.checked,
            }))}
          />
          <span className="toggle-copy">
            <strong>Show SOS tab</strong>
            <small>Shared across every device after saving</small>
          </span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={draft.discardTrackingEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              discardTrackingEnabled: event.target.checked,
            }))}
          />
          <span className="toggle-copy">
            <strong>Show Discard tab</strong>
            <small>Track product sent directly to trash</small>
          </span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={draft.cardScrubEnabled}
            onChange={(event) => setDraft((current) => ({
              ...current,
              cardScrubEnabled: event.target.checked,
            }))}
          />
          <span className="toggle-copy">
            <strong>Enable hold-and-slide card adjustments</strong>
            <small>Shared across every device · Left subtracts, right adds</small>
          </span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={testDaypartEnabled}
            onChange={(event) => setTestDaypartEnabled(event.target.checked)}
          />
          <span className="toggle-copy">
            <strong>Enable Test Daypart</strong>
            <small>This device only · Test entries are never saved</small>
          </span>
        </label>
        <div className="alarm-test-control">
          <span className="toggle-copy">
            <strong>Cooldown alarm</strong>
            <small>This device only · Beeps, Pan 1 voice announcement, then beeps</small>
          </span>
          <label className="alarm-volume-control">
            <span>
              <strong>Voice volume</strong>
              <output>{Math.round(draft.alarmVoiceVolume * 100)}%</output>
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={Math.round(draft.alarmVoiceVolume * 100)}
              onChange={(event) => setDraft((current) => ({
                ...current,
                alarmVoiceVolume: Number(event.target.value) / 100,
              }))}
              aria-label="Voice announcement volume"
            />
            <small>Shared across every device after Save all changes · Beep volume is unchanged</small>
          </label>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void playCooldownAlarm({
                panId: 'pan-1',
                voiceVolume: draft.alarmVoiceVolume,
              }).then((played) => {
                notify(played ? 'Alarm playback started on this device.' : 'This browser blocked alarm playback.');
              });
            }}
          >
            <Timer aria-hidden="true" /> Test alarm
          </button>
        </div>
      </div>
      <details className="admin-dropdown">
        <summary>Product case pricing and unit weights</summary>
      <div className="data-table-wrap">
        <table className="data-table admin-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Whole case cost</th>
              <th>Whole case weight</th>
              <th>Per-unit weight</th>
              <th>Measurement</th>
              <th>Calculated price</th>
            </tr>
          </thead>
          <tbody>
            {draft.products.map((product) => {
              return (
                <tr key={product.id}>
                  <td>
                    <strong>{product.name}</strong>
                    <span className="cell-detail">
                      {product.trackingUnit === 'cup' ? `${product.unitsPerCup || product.tapQuantity} units per cup` : 'Tracked per each'}
                    </span>
                  </td>
                  <td>
                    <input
                      className="table-input"
                      aria-label={`${product.name} whole case cost`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={product.caseCost || ''}
                      onChange={(event) => updateProduct(product.id, { caseCost: Number(event.target.value) || 0 })}
                    />
                  </td>
                  <td>
                    <input
                      className="table-input"
                      aria-label={`${product.name} whole case weight in pounds`}
                      type="number"
                      min="0"
                      step="0.01"
                      value={product.caseWeightLb || ''}
                      onChange={(event) => updateProduct(product.id, { caseWeightLb: Number(event.target.value) || 0 })}
                    />
                    <span className="cell-detail">Pounds</span>
                  </td>
                  <td>
                    <input
                      className="table-input"
                      aria-label={`${product.name} per-unit weight`}
                      type="number"
                      min="0"
                      step="0.001"
                      value={product.perUnitWeight ?? product.averageWeightLb}
                      onChange={(event) => updateProduct(product.id, { perUnitWeight: Number(event.target.value) || 0 })}
                    />
                  </td>
                  <td>
                    <select
                      className="table-input"
                      aria-label={`${product.name} per-unit weight measurement`}
                      value={product.perUnitWeightUnit || 'lb'}
                      onChange={(event) => updateProduct(product.id, {
                        perUnitWeightUnit: event.target.value as WeightUnit,
                      })}
                    >
                      <option value="oz">Ounces</option>
                      <option value="lb">Pounds</option>
                      <option value="g">Grams</option>
                    </select>
                  </td>
                  <td>
                    <output className="calculated-value">{productTrackingPriceLabel(product)}</output>
                    {product.trackingUnit === 'cup' && (
                      <span className="cell-detail">{formatMoney(product.unitCost)} per nugget</span>
                    )}
                    {(!product.caseCost || !product.caseWeightLb) && (
                      <span className="cell-detail">Enter case cost and weight to recalculate</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </details>
      <details className="admin-dropdown">
        <summary>Daypart targets · {daypart.label}</summary>
        <div className="admin-strip">
          <label>Daypart<select value={selectedDaypart} onChange={(event) => setSelectedDaypart(event.target.value as DaypartId)}>{draft.dayparts.map((part) => <option value={part.id} key={part.id}>{part.label} · {formatMinutes(part.startMinutes)}–{formatMinutes(part.endMinutes)}</option>)}</select></label>
          <label>Whole daypart target<input type="number" value={calculatedDaypartTarget.toFixed(2)} readOnly /></label>
        </div>
      <div className="data-table-wrap">
        <table className="data-table admin-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Target quantity</th>
              <th>Target dollars</th>
              <th>Cases this daypart</th>
              <th>Cases for full day</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const quantity = daypart.productTargetQuantities[product.id] || 0;
              const targetDollars = targetDollarForProduct(product, quantity);
              const daypartCases = targetCasesForProduct(product, quantity);
              const dailyCases = dailyCasesForProduct(product);
              return (
                <tr key={product.id}>
                  <td><strong>{product.name}</strong><span className="cell-detail">{product.trackingUnit === 'cup' ? 'Quantity in cups' : 'Quantity in each'}</span></td>
                  <td><input className="table-input" type="number" min="0" step="0.01" value={formatQuantity(quantity)} onChange={(event) => updateQuantity(product.id, Number(event.target.value) || 0)} /></td>
                  <td><output className="calculated-value">{formatMoney(targetDollars)}</output></td>
                  <td><output className="calculated-value">{formatCases(daypartCases)}</output></td>
                  <td><output className="calculated-value">{formatCases(dailyCases)}</output></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}><strong>Whole daypart target</strong></td>
              <td><strong>{formatMoney(calculatedDaypartTarget)}</strong></td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      </details>
      <details className="admin-dropdown">
        <summary>Export reports</summary>
        <div className="export-panel">
        <div>
          <p>Download cool down trends or submitted donation totals for the selected range. Every workbook includes daily usage scores and confidence.</p>
        </div>
        <label>
          Starting date
          <input type="date" value={exportStartDate} onChange={(event) => {
            setExportStartDate(event.target.value);
            setExportPeriod('custom');
          }} />
        </label>
        <label>
          Ending date
          <input type="date" value={exportEndDate} onChange={(event) => {
            if (exportPeriod === 'custom') {
              setExportEndDate(event.target.value);
            } else {
              updateExportDates(exportPeriod, event.target.value);
            }
          }} />
        </label>
        <label>
          Period
          <select value={exportPeriod} onChange={(event) => {
            const value = event.target.value;
            const isBusinessPreset = value === 'week-to-date'
              || value === 'previous-week'
              || value === 'month-to-date';
            const period = value === 'custom' || isBusinessPreset
              ? value as ExportPeriod
              : Number(value) as 1 | 30 | 60 | 90;
            updateExportDates(period, isBusinessPreset ? dayKey() : exportEndDate);
          }}>
            <option value={1}>Selected day</option>
            <option value="week-to-date">Week to date (Mon–Sat)</option>
            <option value="previous-week">Previous week (Mon–Sat)</option>
            <option value="month-to-date">Month to date (no Sundays)</option>
            <option value={30}>Current 30 days</option>
            <option value={60}>Current 60 days</option>
            <option value={90}>Current 90 days</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        <label>
          Data source
          <select value={exportSource} onChange={(event) => {
            setExportSource(event.target.value as 'live' | 'demo');
          }}>
            <option value="live">Live data</option>
            <option value="demo">Demo data</option>
          </select>
        </label>
        <label>
          Cool Down aggregate by
          <select value={exportGrouping} onChange={(event) => {
            setExportGrouping(event.target.value as WasteExportGrouping);
          }}>
            <option value="hour">Hour</option>
            <option value="daypart">Daypart</option>
          </select>
        </label>
        <label>
          Cool Down values
          <select value={exportMetric} onChange={(event) => {
            setExportMetric(event.target.value as 'cost' | 'quantity');
          }}>
            <option value="cost">Dollars</option>
            <option value="quantity">Units</option>
          </select>
        </label>
        <button className="primary-button" onClick={exportWaste} disabled={exporting || !exportStartDate || !exportEndDate}>
          <Download aria-hidden="true" /> {exporting ? 'Preparing…' : 'Download cool down workbook'}
        </button>
        <button className="secondary-button" onClick={exportDonations} disabled={exportingDonations || !exportStartDate || !exportEndDate}>
          <Download aria-hidden="true" /> {exportingDonations ? 'Preparing…' : 'Download donations workbook'}
        </button>
        <div className="demo-data-controls">
          <div>
            <strong>Demo export data</strong>
            <span>Stored separately from live operational records.</span>
          </div>
          <button className="secondary-button" onClick={seedDemoData} disabled={changingDemoData}>
            {changingDemoData ? 'Working…' : 'Seed demo data'}
          </button>
          <button className="secondary-button danger-button" onClick={removeDemoData} disabled={changingDemoData}>
            Remove demo data
          </button>
        </div>
        </div>
      </details>
      <p className="footnote">Over-target alerts are muted for {draft.warningCooldownSeconds} seconds after dismissal. Case pricing derives the per-unit cost; donation predictions use the normalized per-unit weight.</p>
    </section>
  );
}

function AdminUnlock({ onClose, onUnlocked }: { onClose: () => void; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (password === ADMIN_PASSWORD) {
      onUnlocked();
      return;
    }
    setError('Admin password is incorrect.');
  };
  return (
    <Modal title="Unlock Admin" icon={<ShieldCheck />} onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <p>Enter the store admin password.</p>
        <label>Admin password<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button">Unlock</button>
      </form>
    </Modal>
  );
}

function Modal({ title, icon, onClose, children }: { title: string; icon?: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <h2>{icon}{title}</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X /></button>
        </div>
        {children}
      </section>
    </div>
  );
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: 'danger' }) {
  return <div className={`stat ${tone === 'danger' ? 'danger' : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function AlarmMutedNotice({ page, timeout }: { page: string; timeout?: string }) {
  return (
    <div className="alarm-muted-notice" role="note">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>Cooldown alarms are muted on this device while {page} is open.</strong>
        <span>Other devices on Cool Down keep alarming normally. {timeout
          ? `This device returns to Cool Down after ${timeout} of inactivity.`
          : 'This page stays open until you choose another tab.'}</span>
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state"><Clock3 aria-hidden="true" /><span>{children}</span></div>;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return new Date(2000, 0, 1, hours, mins).toLocaleTimeString([], { hour: 'numeric', minute: mins ? '2-digit' : undefined });
}

function formatHourRange(hour: number): string {
  return `${formatMinutes(hour * 60)}–${formatMinutes((hour + 1) * 60)}`;
}

function formatDayKeyLabel(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function productTrackingPriceLabel(product: ProductConfig): string {
  const trackingQuantity = product.trackingUnit === 'cup'
    ? product.unitsPerCup || product.tapQuantity
    : 1;
  const trackingUnit = product.trackingUnit === 'cup' ? 'cup' : 'each';
  return `${formatMoney(product.unitCost * trackingQuantity)}/${trackingUnit}`;
}

function formatCases(value: number | null): string {
  if (value === null) return 'Not configured';
  return `${value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} cases`;
}

export default App;
