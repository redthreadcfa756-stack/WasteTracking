import {
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth';
import {
  addDoc,
  arrayUnion,
  arrayRemove,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
  writeBatch,
  type FirestoreError,
  type Unsubscribe,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { adjustCooldownProductQuantities, buildDailyWasteSummary, isOperatingDayKey } from './domain';
import type { AppSettings, CooldownPanId, CooldownTimer, DailyWasteSummary, DaypartId, DaypartUsageOutcome, DiscardEvent, DonationRecord, MemberProfile, SosEntry, UsageDayRecord, WasteEvent } from './types';

function requireFirebase() {
  if (!auth || !db) throw new Error('Firebase environment variables are missing.');
  return { auth, db };
}

export function observeAuth(callback: (user: User | null) => void): Unsubscribe {
  const services = requireFirebase();
  let signingIn = false;
  return onAuthStateChanged(services.auth, (user) => {
    if (user) {
      callback(user);
      return;
    }
    if (signingIn) return;
    signingIn = true;
    signInAnonymously(services.auth)
      .catch(() => callback(null))
      .finally(() => {
        signingIn = false;
      });
  });
}

export async function login(email: string, password: string): Promise<void> {
  const services = requireFirebase();
  await signInWithEmailAndPassword(services.auth, email.trim(), password);
}

export async function logout(): Promise<void> {
  const services = requireFirebase();
  await signOut(services.auth);
}

export async function reauthenticate(password: string): Promise<void> {
  const services = requireFirebase();
  const user = services.auth.currentUser;
  if (!user?.email) throw new Error('This account cannot be reauthenticated with a password.');
  const credential = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, credential);
}

export function subscribeMember(
  uid: string,
  callback: (member: MemberProfile | null) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  return onSnapshot(doc(services.db, 'members', uid), (snapshot) => {
    callback(snapshot.exists() ? ({ uid: snapshot.id, ...snapshot.data() } as MemberProfile) : null);
  }, onError);
}

export function subscribeSettings(
  storeId: string,
  callback: (settings: AppSettings | null) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  return onSnapshot(doc(services.db, 'stores', storeId, 'settings', 'app'), (snapshot) => {
    callback(snapshot.exists() ? snapshot.data() as AppSettings : null);
  }, onError);
}

export async function saveSettings(storeId: string, settings: AppSettings): Promise<void> {
  const services = requireFirebase();
  await setDoc(doc(services.db, 'stores', storeId, 'settings', 'app'), {
    ...settings,
    updatedAt: serverTimestamp(),
    updatedBy: services.auth.currentUser?.uid,
  });
}

export function subscribeUsageDay(
  storeId: string,
  selectedDayKey: string,
  callback: (record: UsageDayRecord | null) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  return onSnapshot(doc(services.db, 'stores', storeId, 'usageDays', selectedDayKey), (snapshot) => {
    callback(snapshot.exists() ? snapshot.data() as UsageDayRecord : null);
  }, onError);
}

export async function recordUsageHeartbeat({
  storeId,
  selectedDayKey,
  slotKey,
  deviceName,
  recordedBy,
}: {
  storeId: string;
  selectedDayKey: string;
  slotKey: string;
  deviceName: string;
  recordedBy: string;
}): Promise<void> {
  const services = requireFirebase();
  const recordRef = doc(services.db, 'stores', storeId, 'usageDays', selectedDayKey);
  await setDoc(recordRef, {
    storeId,
    dayKey: selectedDayKey,
    activeSlotKeys: arrayUnion(slotKey),
    updatedAt: serverTimestamp(),
    lastRecordedBy: recordedBy,
    lastDeviceName: deviceName,
  }, { merge: true });
}

export async function recordDaypartUsageOutcome({
  storeId,
  selectedDayKey,
  daypartId,
  outcome,
  deviceName,
  recordedBy,
}: {
  storeId: string;
  selectedDayKey: string;
  daypartId: DaypartId;
  outcome: DaypartUsageOutcome;
  deviceName: string;
  recordedBy: string;
}): Promise<void> {
  const services = requireFirebase();
  const recordRef = doc(services.db, 'stores', storeId, 'usageDays', selectedDayKey);
  await setDoc(recordRef, {
    storeId,
    dayKey: selectedDayKey,
    zeroWasteDaypartIds: outcome === 'zero-waste' ? arrayUnion(daypartId) : arrayRemove(daypartId),
    missedWasteDaypartIds: outcome === 'missed-waste' ? arrayUnion(daypartId) : arrayRemove(daypartId),
    uncertainWasteDaypartIds: outcome === 'uncertain' ? arrayUnion(daypartId) : arrayRemove(daypartId),
    updatedAt: serverTimestamp(),
    lastRecordedBy: recordedBy,
    lastDeviceName: deviceName,
  }, { merge: true });
}

export function subscribeWasteForDay(
  storeId: string,
  selectedDayKey: string,
  callback: (events: WasteEvent[], hasPendingWrites: boolean) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  const eventsQuery = query(
    collection(services.db, 'stores', storeId, 'wasteEvents'),
    where('dayKey', '==', selectedDayKey),
    orderBy('eventAt', 'desc'),
  );
  return onSnapshot(eventsQuery, { includeMetadataChanges: true }, (snapshot) => {
    callback(
      snapshot.docs.map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() } as WasteEvent)),
      snapshot.metadata.hasPendingWrites,
    );
  }, onError);
}

export function subscribeDailyWasteSummaries(
  storeId: string,
  startDayKey: string,
  endDayKey: string,
  callback: (summaries: DailyWasteSummary[]) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  const summariesQuery = query(
    collection(services.db, 'stores', storeId, 'dailyWasteSummaries'),
    where('dayKey', '>=', startDayKey),
    where('dayKey', '<=', endDayKey),
  );
  return onSnapshot(summariesQuery, { includeMetadataChanges: true }, (snapshot) => {
    callback(snapshot.docs.map((summaryDoc) => summaryDoc.data() as DailyWasteSummary));
  }, onError);
}

function operatingDayKeysInRange(startDayKey: string, endDayKey: string): string[] {
  if (startDayKey > endDayKey) return [];
  const cursor = new Date(`${startDayKey}T12:00:00`);
  const end = new Date(`${endDayKey}T12:00:00`);
  const result: string[] = [];
  while (cursor <= end) {
    const selectedDayKey = [
      cursor.getFullYear(),
      String(cursor.getMonth() + 1).padStart(2, '0'),
      String(cursor.getDate()).padStart(2, '0'),
    ].join('-');
    if (isOperatingDayKey(selectedDayKey)) result.push(selectedDayKey);
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

export async function ensureDailyWasteSummaries(
  storeId: string,
  startDayKey: string,
  endDayKey: string,
  { forceRebuild = false }: { forceRebuild?: boolean } = {},
): Promise<void> {
  const requiredDayKeys = operatingDayKeysInRange(startDayKey, endDayKey);
  if (requiredDayKeys.length === 0) return;

  const services = requireFirebase();
  const summariesCollection = collection(services.db, 'stores', storeId, 'dailyWasteSummaries');
  const existingSnapshot = await getDocs(query(
    summariesCollection,
    where('dayKey', '>=', startDayKey),
    where('dayKey', '<=', endDayKey),
  ));
  const existingDayKeys = new Set(existingSnapshot.docs.map((summaryDoc) => summaryDoc.id));
  const dayKeysToBuild = forceRebuild
    ? requiredDayKeys
    : requiredDayKeys.filter((selectedDayKey) => !existingDayKeys.has(selectedDayKey));
  if (dayKeysToBuild.length === 0) return;

  const computedBy = services.auth.currentUser?.uid || '';
  const summaries = await Promise.all(dayKeysToBuild.map(async (selectedDayKey) => {
    const eventsSnapshot = await getDocs(query(
      collection(services.db, 'stores', storeId, 'wasteEvents'),
      where('dayKey', '==', selectedDayKey),
    ));
    const events = eventsSnapshot.docs.map((eventDoc) => ({
      id: eventDoc.id,
      ...eventDoc.data(),
    } as WasteEvent));
    return buildDailyWasteSummary(events, storeId, selectedDayKey, computedBy);
  }));

  const batch = writeBatch(services.db);
  summaries.forEach((summary) => {
    batch.set(doc(summariesCollection, summary.dayKey), {
      ...summary,
      computedAt: serverTimestamp(),
    });
  });
  await batch.commit();
}

export async function createWasteEvent(event: Omit<WasteEvent, 'id' | 'eventAt'>): Promise<string> {
  const services = requireFirebase();
  const eventDoc = await addDoc(collection(services.db, 'stores', event.storeId, 'wasteEvents'), {
    ...event,
    eventAt: serverTimestamp(),
  });
  return eventDoc.id;
}

export function subscribeCooldownTimers(
  storeId: string,
  callback: (timers: CooldownTimer[], serverConfirmed: boolean) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  return onSnapshot(
    collection(services.db, 'stores', storeId, 'cooldownTimers'),
    { includeMetadataChanges: true },
    (snapshot) => {
      callback(
        snapshot.docs.map((timerDoc) => ({
          id: timerDoc.id,
          ...timerDoc.data(),
        } as CooldownTimer)),
        !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites,
      );
    },
    onError,
  );
}

export async function startOrJoinCooldownTimer({
  storeId,
  panId,
  panLabel,
  productId,
  equivalentUnits,
  createdBy,
  createdByName,
  startIfInactive = true,
}: {
  storeId: string;
  panId: CooldownPanId;
  panLabel: string;
  productId: string;
  equivalentUnits: number;
  createdBy: string;
  createdByName: string;
  startIfInactive?: boolean;
}): Promise<void> {
  const services = requireFirebase();
  const timerRef = doc(services.db, 'stores', storeId, 'cooldownTimers', panId);
  await runTransaction(services.db, async (transaction) => {
    const snapshot = await transaction.get(timerRef);
    const existing = snapshot.exists() ? snapshot.data() as CooldownTimer : null;
    const now = Timestamp.now();
    if (existing?.active) {
      transaction.update(timerRef, {
        lastWasteAt: now,
        joinedWasteCount: (existing.joinedWasteCount || 0) + (equivalentUnits > 0 ? 1 : 0),
        joinedProductIds: equivalentUnits > 0
          ? [...new Set([...(existing.joinedProductIds || []), productId])]
          : existing.joinedProductIds || [],
        productQuantities: adjustCooldownProductQuantities(existing.productQuantities, productId, equivalentUnits),
      });
      return;
    }
    if (!startIfInactive || equivalentUnits <= 0) return;
    transaction.set(timerRef, {
      storeId,
      panLabel,
      active: true,
      startedAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + 60 * 60 * 1000),
      lastWasteAt: now,
      joinedWasteCount: 1,
      joinedProductIds: [productId],
      productQuantities: { [productId]: equivalentUnits },
      startedBy: createdBy,
      startedByName: createdByName,
    });
  });
}

export async function resetCooldownTimer(storeId: string, panId: CooldownPanId): Promise<void> {
  const services = requireFirebase();
  await setDoc(doc(services.db, 'stores', storeId, 'cooldownTimers', panId), {
    storeId,
    panLabel: panId,
    active: false,
    startedAt: null,
    expiresAt: null,
    lastWasteAt: serverTimestamp(),
    joinedWasteCount: 0,
    joinedProductIds: [],
    productQuantities: {},
    startedBy: services.auth.currentUser?.uid || '',
    startedByName: '',
  }, { merge: true });
}

export async function snoozeCooldownTimer(
  storeId: string,
  panId: CooldownPanId,
  durationMs = 60_000,
): Promise<void> {
  const services = requireFirebase();
  const timerRef = doc(services.db, 'stores', storeId, 'cooldownTimers', panId);
  await runTransaction(services.db, async (transaction) => {
    const snapshot = await transaction.get(timerRef);
    if (!snapshot.exists()) return;

    const timer = snapshot.data() as CooldownTimer;
    if (!timer.active) return;

    transaction.update(timerRef, {
      expiresAt: Timestamp.fromMillis(Date.now() + durationMs),
    });
  });
}

export async function resetAllCooldownTimers(storeId: string): Promise<void> {
  await Promise.all((['pan-1', 'pan-2', 'pan-3', 'pan-4'] as CooldownPanId[])
    .map((panId) => resetCooldownTimer(storeId, panId)));
}

export async function loadWasteForDateRange(storeId: string, startDayKey: string, endDayKey: string): Promise<WasteEvent[]> {
  const services = requireFirebase();
  const snapshot = await getDocs(query(
    collection(services.db, 'stores', storeId, 'wasteEvents'),
    where('dayKey', '>=', startDayKey),
    where('dayKey', '<=', endDayKey),
  ));
  return snapshot.docs.map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() } as WasteEvent));
}

export async function loadDemoWasteForDateRange(storeId: string, startDayKey: string, endDayKey: string): Promise<WasteEvent[]> {
  const services = requireFirebase();
  const snapshot = await getDocs(query(
    collection(services.db, 'stores', storeId, 'exportDemoWaste'),
    where('dayKey', '>=', startDayKey),
    where('dayKey', '<=', endDayKey),
  ));
  return snapshot.docs.map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() } as WasteEvent));
}

export async function removeWasteEvents(storeId: string, eventIds: string[]): Promise<void> {
  const services = requireFirebase();
  await Promise.all(eventIds.map((eventId) => deleteDoc(doc(services.db, 'stores', storeId, 'wasteEvents', eventId))));
}

export function subscribeDiscardForDay(
  storeId: string,
  selectedDayKey: string,
  callback: (events: DiscardEvent[], hasPendingWrites: boolean) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  const eventsQuery = query(
    collection(services.db, 'stores', storeId, 'discardEvents'),
    where('dayKey', '==', selectedDayKey),
    orderBy('eventAt', 'desc'),
  );
  return onSnapshot(eventsQuery, { includeMetadataChanges: true }, (snapshot) => {
    callback(
      snapshot.docs.map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() } as DiscardEvent)),
      snapshot.metadata.hasPendingWrites,
    );
  }, onError);
}

export async function createDiscardEvent(event: Omit<DiscardEvent, 'id' | 'eventAt'>): Promise<string> {
  const services = requireFirebase();
  const eventDoc = await addDoc(collection(services.db, 'stores', event.storeId, 'discardEvents'), {
    ...event,
    eventAt: serverTimestamp(),
  });
  return eventDoc.id;
}

export async function removeDiscardEvents(storeId: string, eventIds: string[]): Promise<void> {
  const services = requireFirebase();
  await Promise.all(eventIds.map((eventId) => deleteDoc(doc(services.db, 'stores', storeId, 'discardEvents', eventId))));
}

export function subscribeSosForDay(
  storeId: string,
  selectedDayKey: string,
  callback: (entries: SosEntry[]) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  const sosQuery = query(
    collection(services.db, 'stores', storeId, 'sosEntries'),
    where('dayKey', '==', selectedDayKey),
  );
  return onSnapshot(sosQuery, (snapshot) => {
    callback(snapshot.docs.map((entryDoc) => ({ id: entryDoc.id, ...entryDoc.data() } as SosEntry)));
  }, onError);
}

export async function saveSosEntry(entry: Omit<SosEntry, 'id' | 'loggedAt'>): Promise<void> {
  const services = requireFirebase();
  const entryId = entry.daypartId
    ? `${entry.dayKey}_${entry.daypartId}`
    : `${entry.dayKey}_${String(entry.hourStart).padStart(2, '0')}`;
  await setDoc(doc(services.db, 'stores', entry.storeId, 'sosEntries', entryId), {
    ...entry,
    loggedAt: serverTimestamp(),
  });
}

export function subscribeDonationRecord(
  storeId: string,
  selectedDayKey: string,
  callback: (record: DonationRecord | null) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  return onSnapshot(doc(services.db, 'stores', storeId, 'donationRecords', selectedDayKey), (snapshot) => {
    callback(snapshot.exists() ? snapshot.data() as DonationRecord : null);
  }, onError);
}

export function subscribeDonationRecordsForDateRange(
  storeId: string,
  startDayKey: string,
  endDayKey: string,
  callback: (records: DonationRecord[]) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  const recordsQuery = query(
    collection(services.db, 'stores', storeId, 'donationRecords'),
    where('dayKey', '>=', startDayKey),
    where('dayKey', '<=', endDayKey),
  );
  return onSnapshot(recordsQuery, { includeMetadataChanges: true }, (snapshot) => {
    callback(snapshot.docs.map((recordDoc) => recordDoc.data() as DonationRecord));
  }, onError);
}

export async function loadDonationRecordsForDateRange(
  storeId: string,
  startDayKey: string,
  endDayKey: string,
): Promise<DonationRecord[]> {
  const services = requireFirebase();
  const snapshot = await getDocs(query(
    collection(services.db, 'stores', storeId, 'donationRecords'),
    where('dayKey', '>=', startDayKey),
    where('dayKey', '<=', endDayKey),
  ));
  return snapshot.docs.map((recordDoc) => recordDoc.data() as DonationRecord);
}

export async function loadDemoDonationRecordsForDateRange(
  storeId: string,
  startDayKey: string,
  endDayKey: string,
): Promise<DonationRecord[]> {
  const services = requireFirebase();
  const snapshot = await getDocs(query(
    collection(services.db, 'stores', storeId, 'exportDemoDonations'),
    where('dayKey', '>=', startDayKey),
    where('dayKey', '<=', endDayKey),
  ));
  return snapshot.docs.map((recordDoc) => recordDoc.data() as DonationRecord);
}

export async function seedExportDemoData(
  storeId: string,
  settings: AppSettings,
  createdBy: string,
  createdByName: string,
  deviceName: string,
): Promise<void> {
  const services = requireFirebase();
  let batch = writeBatch(services.db);
  let batchSize = 0;
  const flushBatch = async () => {
    if (batchSize === 0) return;
    await batch.commit();
    batch = writeBatch(services.db);
    batchSize = 0;
  };
  const queueSet = async (reference: Parameters<typeof batch.set>[0], data: Parameters<typeof batch.set>[1]) => {
    batch.set(reference, data);
    batchSize += 1;
    if (batchSize >= 450) await flushBatch();
  };
  const today = new Date();
  const fullMatrixOffsets = new Set([0, 7, 14, 21, 29]);

  for (let offset = 0; offset < 30; offset += 1) {
    const date = new Date(today);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const selectedDayKey = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    const samples = fullMatrixOffsets.has(offset)
      ? settings.products.flatMap((product) => Array.from({ length: 16 }, (_, hourIndex) => {
        const hour = hourIndex + 6;
        const daypart = settings.dayparts.find((part) => (
          hour * 60 >= part.startMinutes && hour * 60 < part.endMinutes
        )) || settings.dayparts[settings.dayparts.length - 1];
        return { product, hour, daypartId: daypart.id, menu: product.menus[0] };
      }))
      : [];
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      const sample = samples[sampleIndex];
      const eventAt = new Date(date);
      eventAt.setHours(sample.hour, 10 + (offset % 35), 0, 0);
      const displayQuantity = 1 + ((sample.hour * 3 + sampleIndex * 2 + offset) % 8);
      const quantity = sample.product.trackingUnit === 'cup'
        ? displayQuantity * (sample.product.unitsPerCup || sample.product.tapQuantity)
        : displayQuantity;
      await queueSet(doc(services.db, 'stores', storeId, 'exportDemoWaste', `${selectedDayKey}_${sampleIndex}`), {
        storeId,
        productId: sample.product.id,
        productName: sample.product.name,
        equivalentUnits: quantity,
        displayQuantity,
        displayUnit: sample.product.trackingUnit === 'cup' ? 'cup' : 'each',
        unitCostSnapshot: sample.product.unitCost,
        eventAt,
        dayKey: selectedDayKey,
        daypartId: sample.daypartId,
        menu: sample.menu,
        deviceName: `Demo · ${deviceName}`,
        createdBy,
        createdByName,
      });
    }
    const actuals = Object.fromEntries(settings.donationItems.map((item, index) => [
      item.id,
      Number((((offset + index) % 7 + 1) * (item.unit === 'lb' ? 0.45 : 1)).toFixed(2)),
    ]));
    const predictions = Object.fromEntries(settings.donationItems.map((item) => [
      item.id,
      Number(((actuals[item.id] || 0) * 0.9).toFixed(2)),
    ]));
    await queueSet(doc(services.db, 'stores', storeId, 'exportDemoDonations', selectedDayKey), {
      storeId,
      dayKey: selectedDayKey,
      actuals,
      predictions,
      units: Object.fromEntries(settings.donationItems.map((item) => [item.id, item.unit])),
      variance: Object.fromEntries(settings.donationItems.map((item) => [
        item.id,
        Number(((actuals[item.id] || 0) - (predictions[item.id] || 0)).toFixed(2)),
      ])),
      initials: 'DEMO',
      submittedAt: date,
      submittedBy: createdBy,
      submittedByName: createdByName,
      revision: 1,
    });
  }
  await flushBatch();
}

export async function removeExportDemoData(storeId: string): Promise<void> {
  const services = requireFirebase();
  const [waste, donations] = await Promise.all([
    getDocs(collection(services.db, 'stores', storeId, 'exportDemoWaste')),
    getDocs(collection(services.db, 'stores', storeId, 'exportDemoDonations')),
  ]);
  const references = [
    ...waste.docs.map((snapshot) => snapshot.ref),
    ...donations.docs.map((snapshot) => snapshot.ref),
  ];
  for (let start = 0; start < references.length; start += 450) {
    const batch = writeBatch(services.db);
    references.slice(start, start + 450).forEach((reference) => batch.delete(reference));
    await batch.commit();
  }
}

export async function saveDonationRecord(record: Omit<DonationRecord, 'submittedAt'>): Promise<void> {
  const services = requireFirebase();
  await setDoc(doc(services.db, 'stores', record.storeId, 'donationRecords', record.dayKey), {
    ...record,
    submittedAt: serverTimestamp(),
  });
}

export async function memberExists(uid: string): Promise<boolean> {
  const services = requireFirebase();
  return (await getDoc(doc(services.db, 'members', uid))).exists();
}
