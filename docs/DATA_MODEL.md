# Firestore data model

```text
members/{uid}
  storeId, displayName, role

stores/{storeId}
  name
  settings/app
    products[], dayparts[], donationItems[], warningCooldownSeconds,
    sosEnabled, discardTrackingEnabled, cardScrubEnabled
  wasteEvents/{autoId}
    cool down product, quantity, cost snapshot, local day/daypart, device, creator, timestamp
  dailyWasteSummaries/{YYYY-MM-DD}
    completed-day cool down cost totals by product/daypart, source event count, computation timestamp
  discardEvents/{autoId}
    direct-to-trash product, quantity, cost snapshot, local day/daypart, device, creator, timestamp
  sosEntries/{YYYY-MM-DD_HH}
    one overwriteable hourly average
  donationRecords/{YYYY-MM-DD}
    one overwriteable final record with actuals, prediction snapshot, variance, initials
  cooldownTimers/{panId}
    one shared pan timer with its expiry, participating products, and
    productQuantities{productId: equivalentUnits}
```

Products may include whole-case cost, whole-case weight in pounds, and a per-unit weight entered in ounces, pounds, or grams. The app normalizes weight to pounds and derives per-unit cost, donation weight, and case-based target allowances.

Cooldown pan assignments are shared across menus. At breakfast, grilled breakfast items and eggs join Pan 1, nuggets join Pan 2, breakfast filets join Pan 3, and breakfast spicy joins Pan 4.

Cool Down taps are separate immutable documents so simultaneous writes from different devices cannot overwrite each other. They remain stored under the legacy `wasteEvents` collection name for compatibility. The recent-activity UI merges documents by product and minute.

The first connected device on each new operating day creates any missing `dailyWasteSummaries` documents for completed days. Month-to-date daypart leaders read these compact daily records instead of every individual Cool Down tap. Sundays and the current, incomplete day are excluded; deterministic document IDs make concurrent calculations converge on the same summary.

Discard taps use their own immutable collection. They count together with Cool Down entries toward the shared daypart waste target, but never start or change a cooldown pan, contribute to donation predictions, or appear in Cool Down exports. Recent activity merges them by product and minute.

SOS document IDs are deterministic by date and daypart. Re-entering a daypart updates the same record. Older hourly records remain readable.

Donation document IDs are deterministic by count date. Resubmitting replaces the same final document and increments its revision; it does not create duplicate final counts.

Every read and write is scoped through the signed-in user’s `members/{uid}.storeId`. Only a member whose role is `admin` may update shared settings. Admin-panel entry also reauthenticates the current Firebase password every time the tab is entered.

Cooldown pan quantities accumulate by product while a pan is active and reset when that pan is completed or canceled. Snoozing updates the shared expiry to one minute from the action so every connected device re-arms against the same time.

Test Daypart entries exist only in the current browser session. They do not create cool down events, update cooldown timers, affect donations, or appear in exports.

The SOS and Discard tabs can be shown or hidden for all devices from Admin. Hold-and-slide card adjustments can also be enabled or disabled store-wide. Existing data is retained when a feature is hidden or disabled. SOS and card scrubbing default to enabled for existing settings documents; Discard defaults to hidden until explicitly enabled.
