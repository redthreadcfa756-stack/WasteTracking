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
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
  startOrJoinCooldownTimer,
} from './data';
import { DEFAULT_SETTINGS } from './defaults';
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
  parseDuration,
  productWaste,
  targetDollarForProduct,
  type WasteExportGrouping,
} from './domain';
import { createDonationWorkbook, createWasteTrendWorkbook } from './exportWorkbook';
import { firebaseConfigured } from './firebase';
import { useAuthUser, useDeviceName, useMember, useNow, useOnlineStatus, useStoreData } from './hooks';
import type {
  AppSettings,
  CooldownPanId,
  CooldownTimer,
  DaypartId,
  DiscardEvent,
  DonationItemConfig,
  DonationRecord,
  MemberProfile,
  MenuId,
  ProductConfig,
  SosEntry,
  WasteEvent,
} from './types';

type TabId = 'waste' | 'discard' | 'sos' | 'donations' | 'admin';
type MenuSelection = 'auto' | MenuId;
type ExportPeriod = 1 | 30 | 60 | 90 | 'custom';
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || '00756';
const WRITE_TIMEOUT_MS = 8_000;
const COOLDOWN_PANS: Array<{
  id: CooldownPanId;
  label: string;
  productIds: string[];
}> = [
  { id: 'pan-1', label: 'Top pan (Pan 1)', productIds: ['grilled-filets', 'grilled-nuggets'] },
  { id: 'pan-2', label: 'Pan 2', productIds: ['nuggets', 'strips'] },
  { id: 'pan-3', label: 'Pan 3', productIds: ['filets'] },
  { id: 'pan-4', label: 'Bottom pan (Pan 4)', productIds: ['spicy'] },
];
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

let cooldownAudioContext: AudioContext | null = null;

function getCooldownAudioContext(): AudioContext | null {
  if (cooldownAudioContext) return cooldownAudioContext;
  const AudioContextClass = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  cooldownAudioContext = new AudioContextClass();
  return cooldownAudioContext;
}

function playCooldownAlarm() {
  try {
    const context = getCooldownAudioContext();
    if (!context) return;
    if (context.state === 'suspended') void context.resume();
    [0, 0.32, 0.64].forEach((delay) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.35, context.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + delay + 0.24);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(context.currentTime + delay);
      oscillator.stop(context.currentTime + delay + 0.25);
    });
  } catch {
    // The synchronized popup still appears when a browser blocks automatic audio.
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
  const alertedTimers = useRef(new Set<string>());
  const visibleTabs = TABS.filter((tab) => (
    (tab.id !== 'sos' || settings.sosEnabled)
    && (tab.id !== 'discard' || settings.discardTrackingEnabled)
  ));

  useEffect(() => {
    const interval = window.setInterval(() => setTimerNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
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
    const primeAudio = () => {
      const context = getCooldownAudioContext();
      if (context?.state === 'suspended') void context.resume();
    };
    window.addEventListener('pointerdown', primeAudio, { once: true });
    return () => window.removeEventListener('pointerdown', primeAudio);
  }, []);

  const testDaypartActive = testDaypartEnabled && activeTab === 'waste';
  const expiredTimer = settings.cooldownTimersEnabled && !testDaypartActive
    ? storeData.cooldownTimers.find((timer) => timer.active && timestampMillis(timer.expiresAt) <= timerNow)
    : undefined;

  useEffect(() => {
    if (!expiredTimer) return;
    const key = `${expiredTimer.id}:${timestampMillis(expiredTimer.expiresAt)}`;
    if (alertedTimers.current.has(key)) return;
    alertedTimers.current.add(key);
    playCooldownAlarm();
  }, [expiredTimer]);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const completeCooldownTimer = async (timer: CooldownTimer) => {
    try {
      await resetCooldownTimer(member.storeId, timer.id);
      notify(`${timer.panLabel} reset and ready for the next cool down entry.`);
    } catch (caught) {
      notify(errorMessage(caught));
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
            previousWaste={storeData.previousWaste}
            currentWaste={storeData.todayWaste}
            existing={storeData.donationRecord}
            member={member}
            today={storeData.today}
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
          onClose={() => void completeCooldownTimer(expiredTimer)}
        >
          <p>Wrap the pan and place it in the walk-in cooler.</p>
          <button className="primary-button" onClick={() => void completeCooldownTimer(expiredTimer)}>
            <Check /> Pan wrapped and moved
          </button>
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

    try {
      await confirmWrite(createWasteEvent(eventData));
      if (settings.cooldownTimersEnabled) {
        const matchingPans = COOLDOWN_PANS.filter((pan) => pan.productIds.includes(product.id));
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
      notify(errorMessage(caught));
    }
  };

  const subtractWaste = (product: ProductConfig, totalUnits: number) => {
    if (totalUnits <= 0) {
      notify(`No ${product.name} cool down entry to subtract.`);
      return;
    }
    const adjustment = Math.min(product.tapQuantity, totalUnits);
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
          const currentPanUnits = testMode
            ? pan ? Math.max(0, coolDownTotals.units) : null
            : cooldownProductQuantity(activeTimer, product.id);
          const currentPanLabel = testMode
            ? pan ? `${pan.label} · Test pan` : 'No cooldown pan assigned'
            : !settings.cooldownTimersEnabled
              ? 'Cooldown pans off'
              : !pan
                ? 'No cooldown pan assigned'
                : activeTimer ? `${pan.label} · Current pan` : `${pan.label} · Ready`;
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
              />
              {product.trackingUnit === 'cup' && (
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

function WasteCard({ product, currentPanUnits, currentPanLabel, daypartUnits, daypartCost, onAdd, onSubtract }: {
  product: ProductConfig;
  currentPanUnits: number | null;
  currentPanLabel: string;
  daypartUnits: number;
  daypartCost: number;
  onAdd: () => void;
  onSubtract: () => void;
}) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const [holding, setHolding] = useState(false);

  const startPress = () => {
    longPressed.current = false;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      setHolding(false);
      onSubtract();
      navigator.vibrate?.(40);
    }, 650);
  };
  const endPress = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };

  return (
    <button
      className={`waste-card tone-${product.tone}${holding ? ' is-holding' : ''}`}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerLeave={endPress}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onAdd();
      }}
    >
      <span className="waste-card-top">
        <span className="waste-circle">{holding ? '−' : '+'}</span>
        <span>{product.name}</span>
      </span>
      <span className="waste-pan-label">{currentPanLabel}</span>
      <span className={`waste-total${currentPanUnits === null ? ' empty' : ''}`}>
        {currentPanUnits === null ? 'No active pan' : displayProductQuantity(product, currentPanUnits)}
      </span>
      <span className="waste-daypart-total">
        Daypart waste: {displayProductQuantity(product, daypartUnits)} · {formatMoney(daypartCost)}
      </span>
      <span className="waste-hint">Tap to add · Hold to subtract</span>
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

  const subtractDiscard = (product: ProductConfig, totalUnits: number) => {
    if (totalUnits <= 0) {
      notify(`No ${product.name} discard entry to subtract.`);
      return;
    }
    void adjustDiscard(product, -Math.min(product.tapQuantity, totalUnits));
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
                />
                {product.trackingUnit === 'cup' && (
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

function DiscardCard({ product, daypartUnits, onAdd, onSubtract }: {
  product: ProductConfig;
  daypartUnits: number;
  onAdd: () => void;
  onSubtract: () => void;
}) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const [holding, setHolding] = useState(false);

  const startPress = () => {
    longPressed.current = false;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      setHolding(false);
      onSubtract();
      navigator.vibrate?.(40);
    }, 650);
  };
  const endPress = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  };

  return (
    <button
      className={`waste-card discard-card tone-${product.tone}${holding ? ' is-holding' : ''}`}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerLeave={endPress}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onAdd();
      }}
    >
      <span className="waste-card-top">
        <span className="waste-circle">{holding ? '−' : '+'}</span>
        <span>{product.name}</span>
      </span>
      <span className="waste-pan-label">Daypart direct discard</span>
      <span className="waste-total">{displayProductQuantity(product, daypartUnits)}</span>
      <span className="waste-hint">Tap to add · Hold to subtract</span>
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

function DonationsTab({ settings, previousWaste, currentWaste, existing, member, today, notify }: {
  settings: AppSettings;
  previousWaste: WasteEvent[];
  currentWaste: WasteEvent[];
  existing: DonationRecord | null;
  member: MemberProfile;
  today: string;
  notify: (message: string) => void;
}) {
  const livePredictions = useMemo(() => Object.fromEntries(settings.donationItems.map((item) => [
    item.id,
    donationPrediction(item, settings, previousWaste, currentWaste),
  ])), [settings, previousWaste, currentWaste]);
  const predictions = existing?.predictions || livePredictions;
  const [actuals, setActuals] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(!existing);
  const [submitOpen, setSubmitOpen] = useState(false);

  useEffect(() => {
    setActuals(existing?.actuals || Object.fromEntries(settings.donationItems.map((item) => [item.id, predictions[item.id] ?? 0])));
    setEditing(!existing);
  }, [existing, settings.donationItems, predictions]);

  const trackedLbItems = settings.donationItems.filter((item) => item.unit === 'lb' && predictions[item.id] !== null);
  const predictedLb = trackedLbItems.reduce((sum, item) => sum + (predictions[item.id] || 0), 0);
  const actualLb = trackedLbItems.reduce((sum, item) => sum + (actuals[item.id] || 0), 0);
  const varianceLb = actualLb - predictedLb;

  const sourceLabel = (item: DonationItemConfig) => {
    if (item.sourceProductIds.length === 0) return 'Manual count';
    const previousUnits = previousWaste
      .filter((event) => event.daypartId !== 'breakfast' && item.sourceProductIds.includes(event.productId))
      .reduce((sum, event) => sum + event.equivalentUnits, 0);
    const breakfastUnits = currentWaste
      .filter((event) => event.daypartId === 'breakfast' && item.sourceProductIds.includes(event.productId))
      .reduce((sum, event) => sum + event.equivalentUnits, 0);
    const parts = [];
    if (previousUnits) parts.push(`${formatQuantity(previousUnits)} prior`);
    if (breakfastUnits) parts.push(`${formatQuantity(breakfastUnits)} today`);
    return parts.join(' + ') || 'No tracked cool down';
  };

  const usePredictions = () => {
    setActuals((current) => ({
      ...current,
      ...Object.fromEntries(settings.donationItems
        .filter((item) => predictions[item.id] !== null)
        .map((item) => [item.id, predictions[item.id] || 0])),
    }));
    notify('Tracked predictions approved; manual rows retained.');
  };

  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Yesterday Lunch–Late Dinner + today Breakfast</p>
          <h2>Donations reconciliation</h2>
        </div>
        {existing && <span className="status-badge"><Check aria-hidden="true" /> Submitted · revision {existing.revision}</span>}
      </div>
      <div className="stat-grid">
        <Stat label="Predicted tracked lb" value={`${predictedLb.toFixed(2)} lb`} detail="Linked cool down items" />
        <Stat label="Counted tracked lb" value={`${actualLb.toFixed(2)} lb`} detail="Same comparison set" />
        <Stat label="Tracked variance" value={`${varianceLb >= 0 ? '+' : ''}${varianceLb.toFixed(2)} lb`} detail={varianceLb > 0.01 ? 'Possible unlogged cool down' : 'At or below prediction'} tone={varianceLb > 0.01 ? 'danger' : undefined} />
      </div>
      <div className="donation-toolbar">
        <span>{editing ? 'Review counts before submitting.' : `Final count by ${existing?.initials || ''}`}</span>
        <div>
          {editing && <button className="secondary-button small" onClick={usePredictions}><Check /> Use tracked predictions</button>}
          {!editing && <button className="secondary-button small" onClick={() => setEditing(true)}><RotateCcw /> Edit final count</button>}
        </div>
      </div>
      <div className="data-table-wrap">
        <table className="data-table donation-table">
          <thead><tr><th>Donation item</th><th>Tracked source</th><th>Unit</th><th>Predicted</th><th>Actual</th><th>Variance</th></tr></thead>
          <tbody>
            {settings.donationItems.map((item) => {
              const predicted = predictions[item.id];
              const actual = actuals[item.id] || 0;
              const variance = predicted === null ? null : actual - predicted;
              return (
                <tr key={item.id}>
                  <td><strong>{item.name}</strong></td>
                  <td>{sourceLabel(item)}</td>
                  <td>{item.unit === 'lb' ? 'Lbs' : 'Each'}</td>
                  <td>{predicted === null ? '—' : formatDonationNumber(predicted, item.unit)}</td>
                  <td>
                    <input
                      className="table-input"
                      type="number"
                      min="0"
                      step={item.unit === 'lb' ? '0.01' : '1'}
                      value={item.unit === 'lb' ? actual.toFixed(2) : formatQuantity(actual)}
                      disabled={!editing}
                      aria-label={`${item.name} actual ${item.unit === 'lb' ? 'pounds' : 'count'}`}
                      onChange={(event) => setActuals((current) => ({ ...current, [item.id]: Number(event.target.value) || 0 }))}
                    />
                  </td>
                  <td className={variance !== null && variance > 0.01 ? 'danger-text' : ''}>
                    {variance === null ? 'Manual' : `${variance >= 0 ? '+' : ''}${formatDonationNumber(variance, item.unit)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <button className="primary-button submit-day" onClick={() => setSubmitOpen(true)}>{existing ? 'Resubmit final count' : 'Submit final count'} <ChevronRight /></button>}
      {submitOpen && (
        <DonationSubmit
          existing={existing}
          onClose={() => setSubmitOpen(false)}
          onSubmit={async (initials) => {
            const variance = Object.fromEntries(settings.donationItems.map((item) => {
              const predicted = predictions[item.id];
              return [item.id, predicted === null ? null : (actuals[item.id] || 0) - predicted];
            }));
            await saveDonationRecord({
              storeId: member.storeId,
              dayKey: today,
              actuals,
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
            notify(existing ? 'Final donation count replaced.' : 'Final donation count saved.');
          }}
        />
      )}
    </section>
  );
}

function DonationSubmit({ existing, onClose, onSubmit }: {
  existing: DonationRecord | null;
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
    <Modal title={existing ? 'Replace final donation count' : 'Submit final donation count'} onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <p>{existing ? 'This replaces the previously saved final count. No duplicate record will be created.' : 'This saves one final record for today.'}</p>
        <label>Initials<input autoFocus maxLength={5} value={initials} onChange={(event) => setInitials(event.target.value.toUpperCase())} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : existing ? 'Replace final count' : 'Save final count'}</button>
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

  const updateProduct = (productId: string, patch: Partial<ProductConfig>) => {
    setDraft((current) => {
      const nextProducts = current.products.map((product) => product.id === productId ? { ...product, ...patch } : product);
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
      await saveSettings(storeId, draft);
      if (!draft.cooldownTimersEnabled) await resetAllCooldownTimers(storeId);
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
            checked={testDaypartEnabled}
            onChange={(event) => setTestDaypartEnabled(event.target.checked)}
          />
          <span className="toggle-copy">
            <strong>Enable Test Daypart</strong>
            <small>This device only · Test entries are never saved</small>
          </span>
        </label>
      </div>
      <details className="admin-dropdown">
        <summary>Donations · Product unit costs and weights</summary>
      <div className="data-table-wrap">
        <table className="data-table admin-table">
          <thead><tr><th>Product</th><th>Unit cost</th><th>Avg lb/unit</th></tr></thead>
          <tbody>
            {draft.products.map((product) => {
              return (
                <tr key={product.id}>
                  <td><strong>{product.name}</strong><span className="cell-detail">Used for cool down cost and donation estimates</span></td>
                  <td><input className="table-input" type="number" min="0.01" step="0.01" value={product.unitCost} onChange={(event) => updateProduct(product.id, { unitCost: Number(event.target.value) || 0 })} /></td>
                  <td><input className="table-input" type="number" min="0.001" step="0.01" value={product.averageWeightLb} onChange={(event) => updateProduct(product.id, { averageWeightLb: Number(event.target.value) || 0 })} /></td>
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
          <thead><tr><th>Product</th><th>Target quantity</th><th>Target dollars</th></tr></thead>
          <tbody>
            {products.map((product) => {
              const quantity = daypart.productTargetQuantities[product.id] || 0;
              const targetDollars = targetDollarForProduct(product, quantity);
              return (
                <tr key={product.id}>
                  <td><strong>{product.name}</strong><span className="cell-detail">{product.trackingUnit === 'cup' ? 'Quantity in cups' : 'Quantity in each'}</span></td>
                  <td><input className="table-input" type="number" min="0" step="0.01" value={formatQuantity(quantity)} onChange={(event) => updateQuantity(product.id, Number(event.target.value) || 0)} /></td>
                  <td><output className="calculated-value">{formatMoney(targetDollars)}</output></td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}><strong>Whole daypart target</strong></td>
              <td><strong>{formatMoney(calculatedDaypartTarget)}</strong></td>
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
      <p className="footnote">Over-target alerts are muted for {draft.warningCooldownSeconds} seconds after dismissal. Donation predictions use the saved average weights.</p>
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

function formatDonationNumber(value: number, unit: 'lb' | 'each'): string {
  return unit === 'lb' ? `${value.toFixed(2)} lb` : `${formatQuantity(value)} each`;
}

export default App;
