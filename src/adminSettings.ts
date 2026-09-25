import type { AppSettings } from './types';

export function adminSettingsSignature(settings: AppSettings): string {
  // Firestore adds updatedAt/updatedBy to this object at runtime. Those are not
  // editable settings, and structuredClone strips Timestamp's JSON serializer.
  const {
    version, warningCooldownSeconds, cooldownTimersEnabled, sosEnabled,
    discardTrackingEnabled, cardScrubEnabled, alarmVoiceVolume, products,
    dayparts, donationItems,
  } = settings;
  return JSON.stringify({
    version, warningCooldownSeconds, cooldownTimersEnabled, sosEnabled,
    discardTrackingEnabled, cardScrubEnabled, alarmVoiceVolume, products,
    dayparts, donationItems,
  });
}
