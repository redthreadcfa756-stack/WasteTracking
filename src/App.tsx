import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  CloudOff,
  Gift,
  LogOut,
  RotateCcw,
  Save,
  Settings,
  ShieldCheck,
  Timer,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { User } from 'firebase/auth';
import {
  createWasteEvent,
  login,
  logout,
  reauthenticate,
  removeWasteEvents,
  saveDonationRecord,
  saveSettings,
  saveSosEntry,
} from './data';
import { DEFAULT_SETTINGS } from './defaults';
import {
  daypartWaste,
  dayKey,
  detectDaypart,
  displayProductQuantity,
  distributeDollarTarget,
  donationPrediction,
  formatDuration,
  formatMoney,
  formatQuantity,
  mergeActivity,
  parseDuration,
  productWaste,
  targetDollarForProduct,
} from './domain';
import { firebaseConfigured } from './firebase';
import { useAuthUser, useDeviceName, useMember, useNow, useOnlineStatus, useStoreData } from './hooks';
import type {
  AppSettings,
  DaypartId,
  DonationItemConfig,
  DonationRecord,
  MemberProfile,
  MenuId,
  ProductConfig,
  SosEntry,
  WasteEvent,
} from './types';

type TabId = 'waste' | 'sos' | 'donations' | 'admin';
type MenuSelection = 'auto' | MenuId;

const TABS: Array<{ id: TabId; label: string; icon: typeof Trash2 }> = [
  { id: 'waste', label: 'Waste', icon: Trash2 },
  { id: 'sos', label: 'SOS', icon: Timer },
  { id: 'donations', label: 'Shared Table', icon: Gift },
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
  if (!user) return <SignIn />;
  if (!memberState.member) return <MissingMembership user={user} />;
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
        <div className="brand-mark"><Trash2 aria-hidden="true" /></div>
        <p className="eyebrow">Shared operations</p>
        <h1>Waste + SOS</h1>
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
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [warning, setWarning] = useState<{ daypart: string; total: number; target: number } | null>(null);
  const [warningMutedUntil, setWarningMutedUntil] = useState(0);
  const [toast, setToast] = useState('');

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2600);
  };

  const selectTab = (tab: TabId) => {
    if (tab === activeTab) return;
    if (tab === 'admin') {
      if (member.role !== 'admin') {
        notify('This account does not have admin access.');
        return;
      }
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
          <h1>Waste + SOS</h1>
        </div>
        <div className="header-actions">
          <span className={`sync-pill ${online ? '' : 'offline'}`}>
            {online ? <Cloud aria-hidden="true" /> : <CloudOff aria-hidden="true" />}
            {online ? 'Live sync' : 'Offline'}
          </span>
          <button className="icon-button" aria-label="Sign out" onClick={() => logout()}><LogOut /></button>
        </div>
      </header>

      {storeData.error && <div className="error-banner" role="alert">{storeData.error}</div>}

      <nav className="tabbar" aria-label="Primary">
        {TABS.map(({ id, label, icon: Icon }) => (
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
        {activeTab === 'sos' && (
          <SosTab entries={storeData.sosEntries} member={member} deviceName={deviceName} today={storeData.today} notify={notify} />
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
          <AdminTab settings={settings} storeId={member.storeId} deviceName={deviceName} notify={notify} />
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
        <Modal title="Waste is over target" icon={<AlertTriangle />} onClose={() => {
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
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function WasteTab({
  settings,
  events,
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
  const [busyProduct, setBusyProduct] = useState('');
  const products = settings.products.filter((product) => product.menus.includes(effectiveMenu));
  const daypart = settings.dayparts.find((candidate) => candidate.id === targetDaypartId)!;
  const menuEvents = events.filter((event) => event.menu === effectiveMenu);
  const activeWaste = daypartWaste(events, targetDaypartId);
  const merged = mergeActivity(menuEvents, settings.products);
  const totalCost = menuEvents.reduce((sum, event) => sum + event.equivalentUnits * event.unitCostSnapshot, 0);

  const addWaste = async (product: ProductConfig, equivalentUnits: number) => {
    const isCup = product.trackingUnit === 'cup' && equivalentUnits === (product.unitsPerCup || 14);
    const displayQuantity = isCup ? 1 : equivalentUnits;
    const displayUnit = isCup ? 'cup' : 'each';
    setBusyProduct(product.id);
    try {
      await createWasteEvent({
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
      });
      const projectedCost = activeWaste.cost + equivalentUnits * product.unitCost;
      if (projectedCost > daypart.totalDollarTarget && Date.now() >= warningMutedUntil) {
        showWarning({ daypart: daypart.label, total: projectedCost, target: daypart.totalDollarTarget });
      }
    } catch (caught) {
      notify(errorMessage(caught));
    } finally {
      setBusyProduct('');
    }
  };

  const undoLast = async () => {
    const latest = events.find((event) => event.createdBy === member.uid);
    if (!latest) return;
    try {
      await removeWasteEvents(member.storeId, [latest.id]);
      notify('Last waste entry removed.');
    } catch (caught) {
      notify(errorMessage(caught));
    }
  };

  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{daypart.label} · {formatMinutes(daypart.startMinutes)}–{formatMinutes(daypart.endMinutes)}</p>
          <h2>Tap waste as it happens</h2>
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

      <div className="stat-grid">
        <Stat label="Menu waste" value={formatMoney(totalCost)} detail={effectiveMenu === 'breakfast' ? 'Breakfast items' : 'Lunch items'} />
        <Stat label={`${daypart.label} target`} value={formatMoney(daypart.totalDollarTarget)} detail={`${formatMoney(activeWaste.cost)} used`} />
        <Stat label="Target remaining" value={formatMoney(Math.max(0, daypart.totalDollarTarget - activeWaste.cost))} detail={activeWaste.cost > daypart.totalDollarTarget ? 'Over target' : 'Live from all devices'} tone={activeWaste.cost > daypart.totalDollarTarget ? 'danger' : undefined} />
      </div>

      <div className="waste-grid">
        {products.map((product) => {
          const totals = productWaste(menuEvents, product.id);
          return (
            <WasteCard
              key={product.id}
              product={product}
              totalUnits={totals.units}
              totalCost={totals.cost}
              busy={busyProduct === product.id}
              onAdd={() => addWaste(product, product.tapQuantity)}
              onIndividual={() => setNuggetPicker(product)}
            />
          );
        })}
      </div>

      <div className="section-heading activity-heading">
        <div>
          <p className="eyebrow">Merged by product and minute</p>
          <h2>Recent activity</h2>
        </div>
        <button className="secondary-button small" onClick={undoLast} disabled={!events.some((event) => event.createdBy === member.uid)}>
          <RotateCcw aria-hidden="true" /> Undo last
        </button>
      </div>
      <div className="activity-list">
        {merged.length === 0 && <EmptyState>No waste logged for this menu yet.</EmptyState>}
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
        <Modal title="Waste individual nuggets" onClose={() => setNuggetPicker(null)}>
          <p>Choose the number of nuggets. The app saves it as a partial cup using 14 nuggets per cup.</p>
          <div className="number-grid">
            {Array.from({ length: 13 }, (_, index) => index + 1).map((count) => (
              <button key={count} onClick={() => {
                addWaste(nuggetPicker, count);
                setNuggetPicker(null);
              }}>{count}</button>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}

function WasteCard({ product, totalUnits, totalCost, busy, onAdd, onIndividual }: {
  product: ProductConfig;
  totalUnits: number;
  totalCost: number;
  busy: boolean;
  onAdd: () => void;
  onIndividual: () => void;
}) {
  const timer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const canLongPress = product.trackingUnit === 'cup';

  const startPress = () => {
    longPressed.current = false;
    if (!canLongPress) return;
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      onIndividual();
      navigator.vibrate?.(30);
    }, 550);
  };
  const endPress = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <button
      className={`waste-card tone-${product.tone}`}
      disabled={busy}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerCancel={endPress}
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
        <span className="waste-circle">+</span>
        <span>{product.name}</span>
      </span>
      <span className="waste-total">{displayProductQuantity(product, totalUnits)}</span>
      <span>{formatMoney(totalCost)} wasted</span>
      <span className="waste-hint">{canLongPress ? 'Tap 1 cup · Hold for individual' : `${formatMoney(product.unitCost)} each`}</span>
    </button>
  );
}

function SosTab({ entries, member, deviceName, today, notify }: {
  entries: SosEntry[];
  member: MemberProfile;
  deviceName: string;
  today: string;
  notify: (message: string) => void;
}) {
  const currentHour = Math.min(21, Math.max(6, new Date().getHours() - 1));
  const [hour, setHour] = useState(currentHour);
  const [average, setAverage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const seconds = parseDuration(average);
    if (seconds === null) {
      setError('Enter the hourly average as minutes:seconds, such as 4:18.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveSosEntry({
        storeId: member.storeId,
        dayKey: today,
        hourStart: hour,
        averageSeconds: seconds,
        createdBy: member.uid,
        createdByName: member.displayName,
        deviceName,
      });
      setAverage('');
      notify('Hourly SOS average saved.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const todayAverage = entries.length ? entries.reduce((sum, entry) => sum + entry.averageSeconds, 0) / entries.length : 0;
  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div><p className="eyebrow">Manual hourly entry</p><h2>Speed of service</h2></div>
      </div>
      <div className="stat-grid two">
        <Stat label="Hours logged" value={String(entries.length)} detail="One average per hour" />
        <Stat label="Today’s average" value={entries.length ? formatDuration(todayAverage) : '—'} detail="Minutes:seconds" />
      </div>
      <form className="entry-form" onSubmit={submit}>
        <label>
          Hour
          <select value={hour} onChange={(event) => setHour(Number(event.target.value))}>
            {Array.from({ length: 16 }, (_, index) => index + 6).map((value) => (
              <option key={value} value={value}>{formatHourRange(value)}</option>
            ))}
          </select>
        </label>
        <label>
          Reported average
          <input inputMode="numeric" placeholder="4:18" value={average} onChange={(event) => setAverage(event.target.value)} required />
        </label>
        <button className="primary-button" disabled={busy}><Save aria-hidden="true" /> {busy ? 'Saving…' : 'Save hour'}</button>
        {error && <p className="form-error full-row" role="alert">{error}</p>}
      </form>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th>Hour</th><th>Average</th><th>Logged by</th><th>Device</th></tr></thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{formatHourRange(entry.hourStart)}</td>
                <td><strong>{formatDuration(entry.averageSeconds)}</strong></td>
                <td>{entry.createdByName}</td>
                <td>{entry.deviceName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && <EmptyState>No hourly SOS averages logged today.</EmptyState>}
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
    return parts.join(' + ') || 'No tracked waste';
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
          <h2>Shared Table reconciliation</h2>
        </div>
        {existing && <span className="status-badge"><Check aria-hidden="true" /> Submitted · revision {existing.revision}</span>}
      </div>
      <div className="stat-grid">
        <Stat label="Predicted tracked lb" value={`${predictedLb.toFixed(2)} lb`} detail="Linked waste items" />
        <Stat label="Counted tracked lb" value={`${actualLb.toFixed(2)} lb`} detail="Same comparison set" />
        <Stat label="Tracked variance" value={`${varianceLb >= 0 ? '+' : ''}${varianceLb.toFixed(2)} lb`} detail={varianceLb > 0.01 ? 'Possible unlogged waste' : 'At or below prediction'} tone={varianceLb > 0.01 ? 'danger' : undefined} />
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

function AdminTab({ settings, storeId, deviceName, notify }: {
  settings: AppSettings;
  storeId: string;
  deviceName: string;
  notify: (message: string) => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [selectedDaypart, setSelectedDaypart] = useState<DaypartId>('breakfast');
  const [saving, setSaving] = useState(false);
  const [device, setDevice] = useState(deviceName);

  useEffect(() => setDraft(structuredClone(settings)), [settings]);

  const daypartIndex = draft.dayparts.findIndex((part) => part.id === selectedDaypart);
  const daypart = draft.dayparts[daypartIndex];
  const products = draft.products.filter((product) => product.menus.includes(daypart.menu));

  const updateProduct = (productId: string, patch: Partial<ProductConfig>) => {
    setDraft((current) => ({
      ...current,
      products: current.products.map((product) => product.id === productId ? { ...product, ...patch } : product),
    }));
  };
  const updateDaypart = (patch: Partial<typeof daypart>) => {
    setDraft((current) => ({
      ...current,
      dayparts: current.dayparts.map((part) => part.id === selectedDaypart ? { ...part, ...patch } : part),
    }));
  };
  const updateQuantity = (productId: string, quantity: number) => {
    updateDaypart({ productTargetQuantities: { ...daypart.productTargetQuantities, [productId]: Math.max(0, quantity) } });
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveSettings(storeId, draft);
      localStorage.setItem('waste-sos-device-name', device.trim() || 'Web device');
      notify('Admin settings saved for every device.');
    } catch (caught) {
      notify(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div><p className="eyebrow">Protected settings</p><h2>Targets, costs, and weights</h2></div>
        <button className="primary-button" onClick={save} disabled={saving}><Save /> {saving ? 'Saving…' : 'Save all changes'}</button>
      </div>
      <div className="admin-strip">
        <label>Daypart<select value={selectedDaypart} onChange={(event) => setSelectedDaypart(event.target.value as DaypartId)}>{draft.dayparts.map((part) => <option value={part.id} key={part.id}>{part.label} · {formatMinutes(part.startMinutes)}–{formatMinutes(part.endMinutes)}</option>)}</select></label>
        <label>Whole daypart target<input type="number" min="0" step="0.01" value={daypart.totalDollarTarget} onChange={(event) => updateDaypart({ totalDollarTarget: Number(event.target.value) || 0 })} /></label>
        <button className="secondary-button" onClick={() => updateDaypart({
          productTargetQuantities: distributeDollarTarget(products, daypart, daypart.totalDollarTarget),
        })}><BarChart3 /> Break down target</button>
        <label>This device name<input value={device} onChange={(event) => setDevice(event.target.value)} /></label>
      </div>
      <div className="data-table-wrap">
        <table className="data-table admin-table">
          <thead><tr><th>Product</th><th>Unit cost</th><th>Avg lb/unit</th><th>Target quantity</th><th>Target dollars</th></tr></thead>
          <tbody>
            {products.map((product) => {
              const quantity = daypart.productTargetQuantities[product.id] || 0;
              const targetDollars = targetDollarForProduct(product, quantity);
              return (
                <tr key={product.id}>
                  <td><strong>{product.name}</strong><span className="cell-detail">{product.trackingUnit === 'cup' ? 'Target quantity in cups' : 'Target quantity in each'}</span></td>
                  <td><input className="table-input" type="number" min="0.01" step="0.01" value={product.unitCost} onChange={(event) => updateProduct(product.id, { unitCost: Number(event.target.value) || 0 })} /></td>
                  <td><input className="table-input" type="number" min="0.001" step="0.01" value={product.averageWeightLb} onChange={(event) => updateProduct(product.id, { averageWeightLb: Number(event.target.value) || 0 })} /></td>
                  <td><input className="table-input" type="number" min="0" step="0.01" value={formatQuantity(quantity)} onChange={(event) => updateQuantity(product.id, Number(event.target.value) || 0)} /></td>
                  <td><input className="table-input" type="number" min="0" step="0.01" value={targetDollars.toFixed(2)} onChange={(event) => {
                    const costPerTargetUnit = product.unitCost * (product.trackingUnit === 'cup' ? (product.unitsPerCup || product.tapQuantity) : 1);
                    updateQuantity(product.id, costPerTargetUnit > 0 ? (Number(event.target.value) || 0) / costPerTargetUnit : 0);
                  }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="footnote">Over-target alerts are muted for {draft.warningCooldownSeconds} seconds after dismissal. Donation predictions use the saved average weights.</p>
    </section>
  );
}

function AdminUnlock({ onClose, onUnlocked }: { onClose: () => void; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await reauthenticate(password);
      onUnlocked();
    } catch (caught) {
      setError('Admin password is incorrect.');
      setBusy(false);
    }
  };
  return (
    <Modal title="Unlock Admin" icon={<ShieldCheck />} onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        <p>Firebase verifies the password every time this tab is opened.</p>
        <label>Admin password<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? 'Verifying…' : 'Unlock'}</button>
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
