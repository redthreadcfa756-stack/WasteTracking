# Waste + SOS Tracker

An iOS-first installable web app with live multi-device waste tracking, hourly SOS entries, Shared Table reconciliation, and protected admin settings.

## Architecture

- **GitHub** stores the source and runs tests on every production push.
- **Cloudflare Pages** serves the compiled static PWA.
- **Firebase Authentication** signs devices in with email/password accounts.
- **Cloud Firestore** provides realtime listeners, offline caching, and the shared backend.

No Cloudflare Function or Firebase Cloud Function is required. That keeps this version compatible with the no-cost tiers. Firestore’s free quota currently includes one free database, 1 GiB stored data, 50,000 reads/day, 20,000 writes/day, and 20,000 deletes/day. Monitor usage as the store adds devices.

## 1. Run locally

Requirements: Node.js 22 and pnpm 10.

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

The app intentionally shows “Connect Firebase” until all six values in `.env.local` are filled.

## 2. Create the Firebase project

1. Create a Firebase project on the **Spark** plan. Analytics is optional.
2. Register a Web app and copy its configuration into `.env.local`.
3. In **Authentication → Sign-in method**, enable **Email/Password**.
4. In **Firestore Database**, create the single production database. Choose a region near the store.
5. Copy `.firebaserc.example` to `.firebaserc` and replace the project ID.
6. Deploy the rules and indexes:

```bash
pnpm dlx firebase-tools login
pnpm dlx firebase-tools deploy --only firestore
```

Do not use Firestore test mode. The included rules require a signed-in store member and enforce admin-only settings writes.

## 3. Create the manager account and store membership

The safest simple setup is:

1. In **Firebase Authentication → Users**, create the manager email account and set its password to the requested admin password.
2. Copy that user’s UID.
3. In **Project settings → Service accounts**, create a temporary private key. Keep it outside this repository.
4. Run the seed command:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json \
ADMIN_UID=the-firebase-user-uid \
ADMIN_NAME="Manager" \
STORE_ID=store-0001 \
STORE_NAME="Your Store Name" \
pnpm seed
```

Delete or securely archive the downloaded service-account key after bootstrap. It is ignored by `.gitignore`, but it should never be committed.

The manager signs in once per device. Opening the Admin tab asks for the Firebase password every time and calls Firebase reauthentication. The password is never embedded in the JavaScript bundle or stored in Firestore.

To add employee-only accounts, create each user in Firebase Authentication and add a `members/{uid}` document:

```json
{
  "storeId": "store-0001",
  "displayName": "Employee initials or name",
  "role": "employee"
}
```

An employee can track waste, SOS, and donations but cannot open or write Admin settings.

## 4. Verify Firebase locally

Sign in with the manager account, open Admin, and press **Save all changes** once. This creates `stores/store-0001/settings/app` from the built-in defaults.

Then open the app in two browser windows. A waste tap in one should appear in the other through the Firestore realtime listener.

## 5. Create the Cloudflare Pages project

This repository uses Wrangler Direct Upload from GitHub Actions. Create a **Direct Upload** Pages project named, for example, `waste-sos-tracker`:

```bash
pnpm dlx wrangler login
pnpm dlx wrangler pages project create waste-sos-tracker
```

Use `main` as the production branch. Do not create a second Git-integrated Pages project for the same site; the included workflow handles deployment.

Create a Cloudflare API token with **Account → Cloudflare Pages → Edit** for the account containing the Pages project.

## 6. Configure the GitHub repository

Under **Settings → Secrets and variables → Actions**, add:

Secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Repository variables:

- `CLOUDFLARE_PAGES_PROJECT` — for example, `waste-sos-tracker`
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

Firebase Web configuration values identify the project but are not backend admin secrets. Firestore rules and Authentication provide the access control.

Push the repository:

```bash
git init
git add .
git commit -m "Initial Waste and SOS tracker"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```

The workflow runs tests, builds `dist`, and deploys it to Cloudflare Pages. Later pushes to `main` repeat the same process.

## 7. Authorize the deployed domain

After the first deployment, add the Cloudflare hostname—such as `waste-sos-tracker.pages.dev`—under **Firebase Authentication → Settings → Authorized domains**. Add the custom domain too if one is attached later.

## 8. Install on iPhone or iPad

Open the HTTPS Cloudflare URL in Safari, tap **Share**, then **Add to Home Screen**. The app uses standalone display mode, safe-area spacing, a service worker shell, and Firestore’s persistent local cache.

## Commands

```bash
pnpm dev        # local development
pnpm test       # domain tests
pnpm typecheck  # TypeScript checks
pnpm build      # production output in dist/
pnpm preview    # preview the production build
```

See [docs/DATA_MODEL.md](docs/DATA_MODEL.md) for the backend layout.
