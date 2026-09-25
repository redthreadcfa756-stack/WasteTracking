import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectFirestoreEmulator, deleteDoc, disableNetwork, doc, enableNetwork, getDoc, getDocs, getFirestore, query, collection, serverTimestamp, setDoc, terminate, updateDoc, where, type Firestore } from 'firebase/firestore';
import { PREP_ITEMS, TABLE_ITEMS } from './saturdayPrep';

// Run against the local emulator only; never points at a real Firebase project.
describe.skipIf(!import.meta.env.FIRESTORE_EMULATOR_HOST)('Saturday Prep shared storage and security rules', () => {
  let app: FirebaseApp;
  let otherApp: FirebaseApp;
  let db: Firestore;
  let otherDb: Firestore;
  const dayKey = '2026-09-05';
  const values = Object.fromEntries([
    ...TABLE_ITEMS.flatMap(([id]) => [[`${id}_lb`, 0], [`${id}_oz`, 0]]),
    ...PREP_ITEMS.flatMap(([id]) => [[`${id}_eod`, 0], [`${id}_left`, 0]]),
  ]);
  const metadata = () => ({ storeId: '00756', dayKey, updatedAt: serverTimestamp(), updatedBy: 'prep-test' });
  const ref = () => doc(db, 'stores', '00756', 'saturdayPrep', dayKey);

  beforeAll(async () => {
    const [host, port] = import.meta.env.FIRESTORE_EMULATOR_HOST!.split(':');
    if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('These tests require a local emulator.');
    await fetch(`http://${host}:${port}/v1/projects/demo-saturday-prep/databases/(default)/documents/stores/00756/saturdayPrep/${dayKey}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });
    app = initializeApp({ projectId: 'demo-saturday-prep' }, 'prep-rules-test');
    otherApp = initializeApp({ projectId: 'demo-saturday-prep' }, 'prep-rules-other-device');
    db = getFirestore(app);
    otherDb = getFirestore(otherApp);
    connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: 'prep-test' } });
    connectFirestoreEmulator(otherDb, host, Number(port), { mockUserToken: { sub: 'other-device' } });
  });
  afterAll(async () => {
    await Promise.all([terminate(db), terminate(otherDb)]);
    await Promise.all([deleteApp(app), deleteApp(otherApp)]);
  });

  it('autosaves partial drafts and merges two devices without erasing other fields', async () => {
    await setDoc(ref(), { ...metadata(), lastEditedField: 'cobb_eod', values: { cobb_eod: 10 } });
    await setDoc(doc(otherDb, 'stores', '00756', 'saturdayPrep', dayKey), {
      ...metadata(), updatedBy: 'other-device', lastEditedField: 'cobb_left', values: { cobb_left: 3 },
    }, { merge: true });
    expect((await getDoc(ref())).data()!.values).toEqual({ cobb_eod: 10, cobb_left: 3 });
  });

  it('rejects incomplete final submissions and malformed draft values', async () => {
    await expect(updateDoc(ref(), { ...metadata(), submittedAt: serverTimestamp() })).rejects.toMatchObject({ code: 'permission-denied' });
    for (const invalid of [{ cobb_eod: -1 }, { cobb_eod: 1.5 }, { romaine_oz: 16 }, { invented: 2 }]) {
      await expect(setDoc(ref(), { ...metadata(), lastEditedField: Object.keys(invalid)[0], values: invalid }, { merge: true })).rejects.toMatchObject({ code: 'permission-denied' });
    }
  });

  it('queues offline entry and saves it on reconnection', async () => {
    await disableNetwork(db);
    const saving = setDoc(ref(), { ...metadata(), lastEditedField: 'market_eod', values: { market_eod: 6 } }, { merge: true });
    await enableNetwork(db);
    await saving;
    expect((await getDoc(ref())).data()!.values.market_eod).toBe(6);
  });

  it('rejects excessive leftovers, submits complete data, and prevents edits after submission', async () => {
    for (const [key, value] of Object.entries({ ...values, cobb_eod: 10, cobb_left: 11 })) {
      await setDoc(ref(), { ...metadata(), lastEditedField: key, values: { [key]: value } }, { merge: true });
    }
    await expect(updateDoc(ref(), { ...metadata(), submittedAt: serverTimestamp() })).rejects.toMatchObject({ code: 'permission-denied' });
    for (const [key, value] of Object.entries({ cobb_left: 3, tea_eod: 2.5, tea_left: .75 })) {
      await setDoc(ref(), { ...metadata(), lastEditedField: key, values: { [key]: value } }, { merge: true });
    }
    await updateDoc(ref(), { ...metadata(), submittedAt: serverTimestamp() });
    expect((await getDoc(ref())).data()!.submittedAt).toBeTruthy();
    await expect(setDoc(ref(), { ...metadata(), lastEditedField: 'cobb_left', values: { cobb_left: 2 } }, { merge: true })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(updateDoc(ref(), { ...metadata(), submittedAt: null, 'values.cobb_left': 2 })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('reopens for correction, resubmits one daily record, and retrieves it by report range', async () => {
    await updateDoc(ref(), { ...metadata(), submittedAt: null });
    await setDoc(ref(), { ...metadata(), lastEditedField: 'cobb_left', values: { cobb_left: 2 } }, { merge: true });
    await updateDoc(ref(), { ...metadata(), submittedAt: serverTimestamp() });
    const report = await getDocs(query(collection(db, 'stores', '00756', 'saturdayPrep'),
      where('dayKey', '>=', dayKey), where('dayKey', '<=', dayKey)));
    expect(report.size).toBe(1);
    expect(report.docs[0].data().values.cobb_left).toBe(2);
    await expect(deleteDoc(ref())).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(setDoc(doc(db, 'stores', 'other-store', 'saturdayPrep', dayKey), {
      ...metadata(), storeId: 'other-store', values,
    })).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
