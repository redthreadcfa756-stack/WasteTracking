import { collection, doc, getDocs, onSnapshot, query, runTransaction, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { auth, db } from './firebase';
import { isSaturday, prepDayKey, prepValidation, validPrepValue, type SaturdayPrepRecord } from './saturdayPrep';

function recordRef(storeId: string, dayKey: string) {
  if (!db || !auth?.currentUser) throw new Error('Connect to the store before opening Saturday Prep.');
  if (!isSaturday(dayKey) || dayKey > prepDayKey()) throw new Error('Choose a Saturday on or before today.');
  return doc(db, 'stores', storeId, 'saturdayPrep', dayKey);
}

export function subscribeSaturdayPrep(
  storeId: string, dayKey: string,
  receive: (record: SaturdayPrepRecord | null, pending: boolean, cached: boolean) => void,
  onError: (error: Error) => void,
) {
  return onSnapshot(recordRef(storeId, dayKey), { includeMetadataChanges: true }, (snapshot) => {
    receive(snapshot.exists() ? snapshot.data() as SaturdayPrepRecord : null,
      snapshot.metadata.hasPendingWrites, snapshot.metadata.fromCache);
  }, onError);
}

// Merge just the edited field so two devices working on different items do not overwrite each other.
// Firestore queues this immediately and persists it offline, even if the user leaves the tab.
export async function savePrepField(storeId: string, dayKey: string, key: string, value: number | null) {
  if (!validPrepValue(key, value)) throw new Error('Enter a valid quantity. Ounces must be less than 16.');
  await setDoc(recordRef(storeId, dayKey), {
    storeId, dayKey, lastEditedField: key, values: { [key]: value }, updatedAt: serverTimestamp(), updatedBy: auth!.currentUser!.uid,
  }, { merge: true });
}

export async function submitSaturdayPrep(storeId: string, dayKey: string, reopen = false) {
  const ref = recordRef(storeId, dayKey);
  await runTransaction(db!, async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new Error('Enter the Saturday log before submitting.');
    const record = snapshot.data() as SaturdayPrepRecord;
    if (!reopen) {
      if (record.submittedAt) throw new Error('This Saturday has already been submitted.');
      const errors = prepValidation(record.values);
      if (errors.length) throw new Error(errors[0]);
    }
    transaction.update(ref, {
      submittedAt: reopen ? null : serverTimestamp(),
      updatedAt: serverTimestamp(), updatedBy: auth!.currentUser!.uid,
    });
  });
}

export async function loadSaturdayPrep(storeId: string, start: string, end: string): Promise<SaturdayPrepRecord[]> {
  if (!db) throw new Error('Connect to the store before downloading reports.');
  if (!start || !end || start > end) throw new Error('Choose a starting date on or before the ending date.');
  const snapshot = await getDocs(query(collection(db, 'stores', storeId, 'saturdayPrep'),
    where('dayKey', '>=', start), where('dayKey', '<=', end)));
  return snapshot.docs.map((item) => item.data() as SaturdayPrepRecord).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}
