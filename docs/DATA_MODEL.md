# Firestore data model

```text
members/{uid}
  storeId, displayName, role

stores/{storeId}
  name
  settings/app
    products[], dayparts[], donationItems[], warningCooldownSeconds
  wasteEvents/{autoId}
    product, quantity, cost snapshot, local day/daypart, device, creator, timestamp
  sosEntries/{YYYY-MM-DD_HH}
    one overwriteable hourly average
  donationRecords/{YYYY-MM-DD}
    one overwriteable final record with actuals, prediction snapshot, variance, initials
  cooldownTimers/{panId}
    one shared pan timer with its expiry, participating products, and
    productQuantities{productId: equivalentUnits}
```

Waste taps are separate immutable documents so simultaneous writes from different devices cannot overwrite each other. The recent-activity UI merges documents by product and minute.

SOS document IDs are deterministic by date and hour. Re-entering the hour updates the same record.

Donation document IDs are deterministic by count date. Resubmitting replaces the same final document and increments its revision; it does not create duplicate final counts.

Every read and write is scoped through the signed-in user’s `members/{uid}.storeId`. Only a member whose role is `admin` may update shared settings. Admin-panel entry also reauthenticates the current Firebase password every time the tab is entered.

Cooldown pan quantities accumulate by product while a pan is active and reset when that pan is completed or canceled.

Test Daypart entries exist only in the current browser session. They do not create waste events, update cooldown timers, affect donations, or appear in exports.
