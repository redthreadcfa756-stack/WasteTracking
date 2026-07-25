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
