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
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
  type FirestoreError,
  type Unsubscribe,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import type { AppSettings, DonationRecord, MemberProfile, SosEntry, WasteEvent } from './types';

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

export function subscribeWasteForDay(
  storeId: string,
  selectedDayKey: string,
  callback: (events: WasteEvent[]) => void,
  onError: (error: FirestoreError) => void,
): Unsubscribe {
  const services = requireFirebase();
  const eventsQuery = query(
    collection(services.db, 'stores', storeId, 'wasteEvents'),
    where('dayKey', '==', selectedDayKey),
    orderBy('eventAt', 'desc'),
  );
  return onSnapshot(eventsQuery, { includeMetadataChanges: true }, (snapshot) => {
    callback(snapshot.docs.map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() } as WasteEvent)));
  }, onError);
}

export async function createWasteEvent(event: Omit<WasteEvent, 'id' | 'eventAt'>): Promise<string> {
  const services = requireFirebase();
  const eventDoc = await addDoc(collection(services.db, 'stores', event.storeId, 'wasteEvents'), {
    ...event,
    eventAt: serverTimestamp(),
  });
  return eventDoc.id;
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
  const batch = writeBatch(services.db);
  const breakfastProducts = settings.products.filter((product) => product.menus.includes('breakfast'));
  const lunchProducts = settings.products.filter((product) => product.menus.includes('lunch'));
  const today = new Date();

  for (let offset = 0; offset < 30; offset += 1) {
    const date = new Date(today);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const selectedDayKey = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    const samples = [
      { product: breakfastProducts[offset % Math.max(1, breakfastProducts.length)], hour: 8, daypartId: 'breakfast' as const, menu: 'breakfast' as const },
      { product: lunchProducts[offset % Math.max(1, lunchProducts.length)], hour: 12, daypartId: 'lunch' as const, menu: 'lunch' as const },
      { product: lunchProducts[(offset + 2) % Math.max(1, lunchProducts.length)], hour: 15, daypartId: 'afternoon' as const, menu: 'lunch' as const },
      { product: lunchProducts[(offset + 4) % Math.max(1, lunchProducts.length)], hour: 18, daypartId: 'early-dinner' as const, menu: 'lunch' as const },
    ].filter((sample) => sample.product);
    samples.forEach((sample, sampleIndex) => {
      const eventAt = new Date(date);
      eventAt.setHours(sample.hour, 10 + (offset % 35), 0, 0);
      const quantity = sample.product.trackingUnit === 'cup'
        ? (sample.product.unitsPerCup || sample.product.tapQuantity)
        : 1 + ((offset + sampleIndex) % 3);
      batch.set(doc(services.db, 'stores', storeId, 'exportDemoWaste', `${selectedDayKey}_${sampleIndex}`), {
        storeId,
        productId: sample.product.id,
        productName: sample.product.name,
        equivalentUnits: quantity,
        displayQuantity: sample.product.trackingUnit === 'cup' ? 1 : quantity,
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
    });
    const actuals = Object.fromEntries(settings.donationItems.map((item, index) => [
      item.id,
      Number((((offset + index) % 7 + 1) * (item.unit === 'lb' ? 0.45 : 1)).toFixed(2)),
    ]));
    const predictions = Object.fromEntries(settings.donationItems.map((item) => [
      item.id,
      Number(((actuals[item.id] || 0) * 0.9).toFixed(2)),
    ]));
    batch.set(doc(services.db, 'stores', storeId, 'exportDemoDonations', selectedDayKey), {
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
  await batch.commit();
}

export async function removeExportDemoData(storeId: string): Promise<void> {
  const services = requireFirebase();
  const [waste, donations] = await Promise.all([
    getDocs(collection(services.db, 'stores', storeId, 'exportDemoWaste')),
    getDocs(collection(services.db, 'stores', storeId, 'exportDemoDonations')),
  ]);
  const batch = writeBatch(services.db);
  waste.docs.forEach((snapshot) => batch.delete(snapshot.ref));
  donations.docs.forEach((snapshot) => batch.delete(snapshot.ref));
  await batch.commit();
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
