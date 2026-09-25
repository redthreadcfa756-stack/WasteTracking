import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import { adminSettingsSignature } from './adminSettings';
import { DEFAULT_SETTINGS } from './defaults';

describe('Admin unsaved-settings detection', () => {
  it('does not count cloning a Firestore timestamp as a settings edit', () => {
    const saved = { ...DEFAULT_SETTINGS, updatedAt: Timestamp.fromMillis(123456), updatedBy: 'team' };
    const draft = structuredClone(saved);
    // Reproduces the previous false-positive check when entering Admin.
    expect(JSON.stringify(draft)).not.toBe(JSON.stringify(saved));
    expect(adminSettingsSignature(draft)).toBe(adminSettingsSignature(saved));
  });

  it('ignores metadata added or refreshed by the server after saving', () => {
    const saved = { ...DEFAULT_SETTINGS, updatedAt: Timestamp.now(), updatedBy: 'another-device' };
    expect(adminSettingsSignature(saved)).toBe(adminSettingsSignature(DEFAULT_SETTINGS));
  });

  it('still detects real changes and becomes clean when they are reverted', () => {
    const draft = structuredClone(DEFAULT_SETTINGS);
    const original = adminSettingsSignature(draft);
    draft.sosEnabled = !draft.sosEnabled;
    expect(adminSettingsSignature(draft)).not.toBe(original);
    draft.sosEnabled = DEFAULT_SETTINGS.sosEnabled;
    expect(adminSettingsSignature(draft)).toBe(original);
    draft.products[0].caseCost = (draft.products[0].caseCost || 0) + 1;
    expect(adminSettingsSignature(draft)).not.toBe(original);
  });
});
