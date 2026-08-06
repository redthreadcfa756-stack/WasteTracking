# Cool Down + SOS Tracker

An iOS-first installable web app with live multi-device cool down tracking, looping pan-expiration alarms with shared one-minute snooze, optional direct-discard tracking, combined daypart waste targets, daypart SOS entries, Shared Table reconciliation, and protected admin settings.

## Architecture

- **GitHub** stores the source and runs tests on every production push.
- **Cloudflare Pages** serves the compiled static PWA.
- **Firebase Authentication** signs devices in anonymously in the background.
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
3. In **Authentication → Sign-in method**, enable **Anonymous**.
4. In **Firestore Database**, create the single production database. Choose a region near the store.
5. Copy `.firebaserc.example` to `.firebaserc` and replace the project ID.
6. Deploy the rules and indexes:

```bash
pnpm dlx firebase-tools login
pnpm dlx firebase-tools deploy --only firestore
```

Do not use Firestore test mode. The included rules require an anonymously signed-in Firebase session and restrict access to store `00756`.

## 3. Configure public store access

Set these additional build variables locally and in Cloudflare Pages:

```text
VITE_STORE_ID=00756
VITE_ADMIN_PASSWORD=00756
```

Change `VITE_ADMIN_PASSWORD` to the desired store password before building. The password is embedded in the browser bundle and is only a convenience lock. Anyone who can inspect or modify requests from the public site can bypass it and write shared settings or operational data.

## 4. Verify Firebase locally

Open the app, enter the configured password in Admin, and press **Save all changes** once. This creates `stores/00756/settings/app` from the built-in defaults.

Then open the app in two browser windows. A cool down tap in one should appear in the other through the Firestore realtime listener.

Admin can configure case cost, case weight, and per-unit weights in ounces, pounds, or grams; the app derives unit pricing, daypart case allowances, and full-day case allowances. Admin can also show or hide the SOS and Discard tabs and enable or disable hold-and-slide card adjustments for all devices. Deploy the included Firestore rules and indexes before enabling Discard so its isolated `discardEvents` collection can sync.

Breakfast Cool Down entries use the shared four-pan timer system: grilled breakfast items and eggs use Pan 1, nuggets use Pan 2, breakfast filets use Pan 3, and breakfast spicy uses Pan 4.

Donation weights use calculator-style entry so typed digits fill from right to left (`1`, `2`, `3` becomes `1.23 lb`) without manually selecting the decimal value.

The Donations tab presents count entry without user-facing prediction amounts. A date selector supports prior dates; revising a submitted date allows corrections to its saved amounts, accepts newly added amounts separately, and calculates the updated totals automatically.

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
- `VITE_STORE_ID`
- `VITE_ADMIN_PASSWORD`

Firebase Web configuration values identify the project but are not backend admin secrets. Firestore rules and Authentication provide the access control.

Push the repository:

```bash
git init
git add .
git commit -m "Initial Cool Down and SOS tracker"
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
