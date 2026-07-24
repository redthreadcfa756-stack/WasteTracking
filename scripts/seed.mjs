import { readFile } from 'node:fs/promises';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const storeId = process.env.STORE_ID || '00756';
const storeName = process.env.STORE_NAME || 'Waste + SOS Store';
const adminName = process.env.ADMIN_NAME || 'Manager';
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
const suppliedUid = process.env.ADMIN_UID;
const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!suppliedUid && (!adminEmail || !adminPassword)) {
  throw new Error('Set ADMIN_UID, or set both ADMIN_EMAIL and ADMIN_PASSWORD.');
}

let credential = applicationDefault();
if (credentialPath) {
  const serviceAccount = JSON.parse(await readFile(credentialPath, 'utf8'));
  credential = cert(serviceAccount);
}

initializeApp({ credential });
const auth = getAuth();
const firestore = getFirestore();

let user;
if (suppliedUid) {
  user = await auth.getUser(suppliedUid);
} else {
  try {
    user = await auth.getUserByEmail(adminEmail);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    user = await auth.createUser({
      email: adminEmail,
      password: adminPassword,
      displayName: adminName,
      emailVerified: true,
    });
  }
}

await Promise.all([
  firestore.doc(`stores/${storeId}`).set({
    name: storeName,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true }),
  firestore.doc(`members/${user.uid}`).set({
    storeId,
    displayName: adminName,
    role: 'admin',
    email: user.email || adminEmail || '',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true }),
]);

console.log(`Seeded admin ${user.email || user.uid} for store ${storeId}.`);
console.log('Sign in, open Admin, and save once to publish the default settings document.');
