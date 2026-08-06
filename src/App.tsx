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
  loadDonationRecordsForDateRange,
  loadDemoDonationRecordsForDateRange,
  loadDemoWasteForDateRange,
  loadWasteForDateRange,
  login,
  logout,
  removeDiscardEvents,
  removeWasteEvents,
  removeExportDemoData,
  resetAllCooldownTimers,
  resetCooldownTimer,
  saveDonationRecord,
  saveSettings,
  saveSosEntry,
  seedExportDemoData,
  snoozeCooldownTimer,
  startOrJoinCooldownTimer,
} from './data';
import { COOLDOWN_PANS, DEFAULT_SETTINGS } from './defaults';
import {
  daypartWaste,
  dayKey,
  cooldownProductQuantity,
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
  targetCasesForProduct,
  targetDollarForProduct,
  withDerivedProductPricing,
  type WasteExportGrouping,
} from './domain';
import { createDonationWorkbook, createWasteTrendWorkbook } from './exportWorkbook';
import { firebaseConfigured } from './firebase';
import { useAuthUser, useDeviceName, useDonationDayData, useMember, useNow, useOnlineStatus, useStoreData } from './hooks';
import type {
  AppSettings,
  CooldownTimer,
  DaypartId,
  DiscardEvent,
  DonationRecord,
  MemberProfile,
  MenuId,
  ProductConfig,
  WeightUnit,
  SosEntry,
  WasteEvent,
} from './types';

type TabId = 'waste' | 'discard' | 'sos' | 'donations' | 'admin';
type MenuSelection = 'auto' | MenuId;
type ExportPeriod = 1 | 30 | 60 | 90 | 'custom';
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || '00756';
const WRITE_TIMEOUT_MS = 8_000;
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
let cooldownAlarmPrimed = false;
let cooldownAlarmPrime: Promise<boolean> | null = null;

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
  cooldownAlarmAudio = new Audio(createCooldownAlarmUrl());
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
  const previousVolume = audio.volume;
  audio.loop = false;
  audio.volume = 0.001;
  cooldownAlarmPrime = audio.play()
    .then(() => {
      audio.pause();
      audio.currentTime = 0;
      cooldownAlarmPrimed = true;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      audio.volume = previousVolume || 1;
      cooldownAlarmPrime = null;
    });
  return cooldownAlarmPrime;
}

function stopCooldownAlarm() {
  if (!cooldownAlarmAudio) return;
  cooldownAlarmAudio.loop = false;
  cooldownAlarmAudio.pause();
  cooldownAlarmAudio.currentTime = 0;
}

function cooldownAlarmIsPlaying() {
  return Boolean(cooldownAlarmAudio && !cooldownAlarmAudio.paused && !cooldownAlarmAudio.ended);
}

async function playCooldownAlarm({ loop = false }: { loop?: boolean } = {}): Promise<boolean> {
  try {
    if (cooldownAlarmPrime) await cooldownAlarmPrime;
    const audio = getCooldownAlarmAudio();
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    audio.loop = loop;
    await audio.play();
    cooldownAlarmPrimed = true;
    return true;
  } catch {
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
  const [timerNow, setTimerNow] = useState(Date.now());
  const [timerActionBusy, setTimerActionBusy] = useState(false);
  const [alarmPlaybackBlocked, setAlarmPlaybackBlocked] = useState(false);
  const alarmActionInProgress = useRef(false);
  const visibleTabs = TABS.filter((tab) => (
    (tab.id !== 'sos' || settings.sosEnabled)
    && (tab.id !== 'discard' || settings.discardTrackingEnabled)
  ));

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

  useEffect(() => {
    const primeAudio = () => void primeCooldownAlarm();
    window.addEventListener('pointerdown', primeAudio);
    window.addEventListener('keydown', primeAudio);
    return () => {
      window.removeEventListener('pointerdown', primeAudio);
      window.removeEventListener('keydown', primeAudio);
    };
  }, []);

  const testDaypartActive = testDaypartEnabled && activeTab === 'waste';
  const expiredTimer = settings.cooldownTimersEnabled && !testDaypartActive
    ? storeData.cooldownTimers.find((timer) => timer.active && timestampMillis(timer.expiresAt) <= timerNow)
    : undefined;
  const expiredTimerKey = expiredTimer
    ? `${expiredTimer.id}:${timestampMillis(expiredTimer.expiresAt)}`
    : '';

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
    const attemptAlarm = async () => {
      if (
        disposed
        || attemptInFlight
        || alarmActionInProgress.current
        || (cooldownAlarmAudio?.loop && cooldownAlarmIsPlaying())
      ) return;
      attemptInFlight = true;
      if (cooldownAlarmPrime) await cooldownAlarmPrime;
      if (disposed) return;
      const played = await playCooldownAlarm({ loop: true });
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

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

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
      void playCooldownAlarm({ loop: true });
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
      void playCooldownAlarm({ loop: true });
    } finally {
      setTimerActionBusy(false);
    }
  };

  const selectTab = (tab: TabId) => {
    if (tab === activeTab) return;
    if (tab === 'admin') {
      setAdminPrompt(true);
      return;
    }
    setActiveTab(tab);
  };

  const nativeDaypartId = detectDaypart(settings.dayparts, now);
  const nativeDaypart = settings.dayparts.find((part) => part.id === nativeDaypartId) || settings.dayparts[0];
  const effectiveMenu = menuSelection === 'auto' ? nativeDaypart.menu : menuSelection;
  const targetDaypartId: DaypartId = effectiveMenu === 'breakfast'
    ? 'breakfast'
    : nativeDaypartId === 'breakfast' ? 'lunch' : nativeDaypartId;

  if (!storeData.ready) return <FullScreenMessage>Loading live store data…</FullScreenMessage>;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Real-time store operations</p>
          <h1>Cool Down + SOS</h1>
        </div>
        <div className="header-actions">
          <span className={`sync-pill ${online ? '' : 'offline'}`}>
            {online ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
            {online ? 'Live sync' : 'Offline'}
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
          <button key={id} className={activeTab === id ? 'active' : ''} onClick={() => selectTab(id)} aria-current={activeTab === id ? 'page' : undefined}>
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
        {activeTab === 'admin' && (
          <AdminTab
            settings={settings}
            member={member}
            deviceName={deviceName}
            testDaypartEnabled={testDaypartEnabled}
            setTestDaypartEnabled={setTestDaypartEnabled}
            notify={notify}
          />
        )}
      </main>

      <footer className="mobile-footer">
        <span>{member.displayName}</span>
        <span>{deviceName}</span>
      </footer>

      {adminPrompt && (
        <AdminUnlock
          onClose={() => setAdminPrompt(false)}
          onUnlocked={() => {
            setAdminPrompt(false);
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
                void playCooldownAlarm({ loop: true }).then((played) => {
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
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function WasteTab({
  settings,
  events,
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
  const previousServerPanQuantities = useRef<Record<string, number> | null>(null);
  const products = settings.products.filter((product) => product.menus.includes(effectiveMenu));
  const daypart = settings.dayparts.find((candidate) => candidate.id === targetDaypartId)!;
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
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {testMode ? 'Test Daypart · Local session' : `${daypart.label} · ${formatMinutes(daypart.startMinutes)}–${formatMinutes(daypart.endMinutes)}`}
          </p>
          <h2>{testMode ? 'Practice cool down entry' : 'Log product entering cool down'}</h2>
        </div>
        <label className="compact-control">
          Menu
          <select value={menuSelection} onChange={(event) => setMenuSelection(event.target.value as MenuSelection)}>
            <option value="auto">Auto · {effectiveMenu === 'breakfast' ? 'Breakfast' : 'Lunch'}</option>
            <option value="breakfast">Breakfast override</option>
            <option value="lunch">Lunch override</option>
          </select>
        </label>
      </div>

      <div className="stat-grid one">
        <Stat
          label={`${testMode ? 'Test · ' : ''}${daypart.label} waste / target`}
          value={`${formatMoney(activeWaste.cost)} / ${formatMoney(daypart.totalDollarTarget)}`}
          detail={`${varianceDetail}${testMode ? ' · Local only' : ' · Cool Down + discard'}`}
          tone={targetVariance > 0 ? 'danger' : undefined}
        />
      </div>

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
              <WasteCard
                product={product}
                currentPanUnits={currentPanUnits}
                currentPanLabel={currentPanLabel}
                daypartUnits={combinedTotals.units}
                daypartCost={combinedTotals.cost}
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

      <div className="section-heading activity-heading">
        <div>
          <p className="eyebrow">{testMode ? 'Temporary entries · Not saved' : 'Merged by product and minute'}</p>
          <h2>{testMode ? 'Test activity' : 'Recent activity'}</h2>
        </div>
        <button className="secondary-button small" onClick={undoLast} disabled={!displayedEvents.some((event) => event.createdBy === member.uid)}>
          <RotateCcw aria-hidden="true" /> Undo last
        </button>
      </div>
      <div className="activity-list">
        {merged.length === 0 && <EmptyState>{testMode ? 'No test cool down entered for this menu.' : 'No cool down logged for this menu yet.'}</EmptyState>}
        {merged.slice(0, 12).map((entry) => {
          const product = settings.products.find((candidate) => candidate.id === entry.productId)!;
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

      {nuggetPicker && (
        <Modal title="Add individual nuggets" onClose={() => setNuggetPicker(null)}>
          <p>Choose how many individual nuggets to add. Fourteen nuggets equals one cup.</p>
          <div className="number-grid">
            {Array.from({ length: 13 }, (_, index) => index + 1).map((count) => (
              <button key={count} onClick={() => {
                void adjustWaste(nuggetPicker, count);
                setNuggetPicker(null);
              }}>{count}</button>
            ))}
          </div>
        </Modal>
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

function WasteCard({
  product,
  currentPanUnits,
  currentPanLabel,
  daypartUnits,
  daypartCost,
  onAdd,
  onSubtract,
  onAdjustQuantity,
}: {
  product: ProductConfig;
  currentPanUnits: number | null;
  currentPanLabel: string;
  daypartUnits: number;
  daypartCost: number;
  onAdd: () => void;
  onSubtract: () => void;
  onAdjustQuantity?: (adjustment: number) => void;
}) {
  const press = useProductCardPress({ onAdd, onSubtract, onAdjustQuantity });

  return (
    <button
      className={`waste-card tone-${product.tone}${press.holding ? ' is-holding' : ''}${onAdjustQuantity ? ' quantity-scrub-card' : ''}${press.scrubAdjustment !== null ? ' is-scrubbing' : ''}`}
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
      <span className="waste-pan-label">{currentPanLabel}</span>
      <span className={`waste-total${currentPanUnits === null ? ' empty' : ''}`}>
        {currentPanUnits === null ? 'No active pan' : displayProductQuantity(product, currentPanUnits)}
      </span>
      <span className="waste-daypart-total">
        Daypart waste: {displayProductQuantity(product, daypartUnits)} · {formatMoney(daypartCost)}
      </span>
      <span className="waste-hint">
        {onAdjustQuantity ? 'Tap +1 · Hold, slide left − / right +' : 'Tap to add · Hold to subtract'}
      </span>
    </button>
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
      <div className="section-heading">
        <div>
          <p className="eyebrow">{daypart.label} · Direct to trash</p>
          <h2>Log product that skips cool down</h2>
        </div>
        <label className="compact-control">
          Menu
          <select value={menuSelection} onChange={(event) => setMenuSelection(event.target.value as MenuSelection)}>
            <option value="auto">Auto · {effectiveMenu === 'breakfast' ? 'Breakfast' : 'Lunch'}</option>
            <option value="breakfast">Breakfast override</option>
            <option value="lunch">Lunch override</option>
          </select>
        </label>
      </div>

      <div className="stat-grid one">
        <Stat
          label={`${daypart.label} waste / target`}
          value={`${formatMoney(activeWaste.cost)} / ${formatMoney(daypart.totalDollarTarget)}`}
          detail={`${varianceDetail} · Cool Down + discard`}
          tone={targetVariance > 0 ? 'danger' : undefined}
        />
      </div>

      <div>
        <p className="discard-step-label">Tap each product sent directly to trash</p>
        <div className="waste-grid">
          {products.map((product) => {
            const totals = productWaste(activeEvents, product.id);
            return (
              <div className="waste-card-wrap" key={product.id}>
                <DiscardCard
                  product={product}
                  daypartUnits={totals.units}
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

      <div className="section-heading activity-heading">
        <div><p className="eyebrow">Merged by product and minute</p><h2>Recent discard activity</h2></div>
        <button className="secondary-button small" onClick={undoLast} disabled={!events.some((event) => event.createdBy === member.uid)}>
          <RotateCcw aria-hidden="true" /> Undo last
        </button>
      </div>
      <div className="activity-list">
        {merged.length === 0 && <EmptyState>No direct discard logged for this menu yet.</EmptyState>}
        {merged.slice(0, 12).map((entry) => {
          const product = settings.products.find((candidate) => candidate.id === entry.productId)!;
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

      {nuggetPicker && (
        <Modal title="Add individual discarded nuggets" onClose={() => setNuggetPicker(null)}>
          <p>Choose how many individual nuggets went directly to trash.</p>
          <div className="number-grid">
            {Array.from({ length: 13 }, (_, index) => index + 1).map((count) => (
              <button key={count} onClick={() => {
                void adjustDiscard(nuggetPicker, count);
                setNuggetPicker(null);
              }}>{count}</button>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}

function DiscardCard({ product, daypartUnits, onAdd, onSubtract, onAdjustQuantity }: {
  product: ProductConfig;
  daypartUnits: number;
  onAdd: () => void;
  onSubtract: () => void;
  onAdjustQuantity?: (adjustment: number) => void;
}) {
  const press = useProductCardPress({ onAdd, onSubtract, onAdjustQuantity });

  return (
    <button
      className={`waste-card discard-card tone-${product.tone}${press.holding ? ' is-holding' : ''}${onAdjustQuantity ? ' quantity-scrub-card' : ''}${press.scrubAdjustment !== null ? ' is-scrubbing' : ''}`}
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
      <span className="waste-pan-label">Daypart direct discard</span>
      <span className="waste-total">{displayProductQuantity(product, daypartUnits)}</span>
      <span className="waste-hint">
        {onAdjustQuantity ? 'Tap +1 · Hold, slide left − / right +' : 'Tap to add · Hold to subtract'}
      </span>
    </button>
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
                notify(existing ? `Updated donation totals saved for ${selectedDayLabel}.` : `Donation totals for ${selectedDayLabel} saved.`);
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

function AdminTab({ settings, member, deviceName, testDaypartEnabled, setTestDaypartEnabled, notify }: {
  settings: AppSettings;
  member: MemberProfile;
  deviceName: string;
  testDaypartEnabled: boolean;
  setTestDaypartEnabled: (enabled: boolean) => void;
  notify: (message: string) => void;
}) {
  const storeId = member.storeId;
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [selectedDaypart, setSelectedDaypart] = useState<DaypartId>('breakfast');
  const [saving, setSaving] = useState(false);
  const [device, setDevice] = useState(deviceName);
  const [exportStartDate, setExportStartDate] = useState(dayKey());
  const [exportEndDate, setExportEndDate] = useState(dayKey());
  const [exportPeriod, setExportPeriod] = useState<ExportPeriod>(1);
  const [exportGrouping, setExportGrouping] = useState<WasteExportGrouping>('hour');
  const [exportMetric, setExportMetric] = useState<'cost' | 'quantity'>('cost');
  const [exporting, setExporting] = useState(false);
  const [exportingDonations, setExportingDonations] = useState(false);
  const [exportSource, setExportSource] = useState<'live' | 'demo'>('live');
  const [changingDemoData, setChangingDemoData] = useState(false);

  useEffect(() => setDraft(structuredClone(settings)), [settings]);

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
      notify('Admin settings saved for every device.');
    } catch (caught) {
      notify(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const updateExportDates = (period: ExportPeriod, endingDate: string) => {
    setExportPeriod(period);
    setExportEndDate(endingDate);
    if (period === 'custom') return;
    if (!endingDate) {
      setExportStartDate('');
      return;
    }
    const startDate = new Date(`${endingDate}T12:00:00`);
    startDate.setDate(startDate.getDate() - (period - 1));
    setExportStartDate(dayKey(startDate));
  };

  const selectedExportDays = () => {
    const start = Date.parse(`${exportStartDate}T00:00:00Z`);
    const end = Date.parse(`${exportEndDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
    return Math.round((end - start) / 86_400_000) + 1;
  };

  const exportWaste = async () => {
    setExporting(true);
    try {
      const exportDays = selectedExportDays();
      if (!exportDays) {
        notify('Choose a starting date that is on or before the ending date.');
        return;
      }
      const events = exportSource === 'demo'
        ? await loadDemoWasteForDateRange(storeId, exportStartDate, exportEndDate)
        : await loadWasteForDateRange(storeId, exportStartDate, exportEndDate);
      if (events.length === 0) {
        notify(`No cool down data was found from ${exportStartDate} through ${exportEndDate}.`);
        return;
      }
      const trend = buildWasteTrend(events, draft, exportGrouping);
      const workbook = await createWasteTrendWorkbook({
        trend,
        settings: draft,
        grouping: exportGrouping,
        startDayKey: exportStartDate,
        endDayKey: exportEndDate,
        source: exportSource,
        metric: exportMetric,
      });
      const url = URL.createObjectURL(new Blob([workbook], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      const link = document.createElement('a');
      link.href = url;
      const sourcePrefix = exportSource === 'demo' ? 'demo-' : '';
      link.download = exportDays === 1
        ? `${sourcePrefix}cool-down-${exportEndDate}-by-${exportGrouping}-${exportMetric}.xlsx`
        : `${sourcePrefix}cool-down-${exportDays}-days-ending-${exportEndDate}-by-${exportGrouping}-${exportMetric}.xlsx`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      notify(`${exportDays}-day cool down export downloaded.`);
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
      const workbook = await createDonationWorkbook({
        records,
        settings: draft,
        startDayKey: exportStartDate,
        endDayKey: exportEndDate,
        source: exportSource,
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
            <small>This device only · Uses its current volume</small>
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              void playCooldownAlarm().then((played) => {
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
          <p>Download cool down trends or submitted donation totals and averages for the selected range.</p>
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
            updateExportDates(value === 'custom' ? 'custom' : Number(value) as 1 | 30 | 60 | 90, exportEndDate);
          }}>
            <option value={1}>Selected day</option>
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
