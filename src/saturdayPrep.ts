import type { Timestamp } from 'firebase/firestore';

export const TABLE_ITEMS = [
  ['shredded-chicken', 'Shredded Grilled Chicken'],
  ['spicy-chicken', 'Spicy Shredded Grilled Chicken'],
  ['romaine', 'Chopped Romaine'],
  ['lettuce-cabbage', 'Lettuce/Cabbage Blend'],
  ['green-leaf', 'Green Leaf Lettuce'],
  ['tomatoes', 'Grape Tomatoes'],
  ['bacon-crumble', 'Bacon Crumble'],
  ['kale-batch', 'Kale (in batch container, not cupped)'],
  ['apples', 'Apples'],
  ['strawberries', 'Strawberries'],
  ['blueberries', 'Blueberries'],
  ['mandarin-oranges', 'Mandarin Oranges'],
  ['cheddar-blend', 'Monterey/Cheddar Blend'],
  ['blue-cheese', 'Blue Cheese Crumble'],
] as const;

export const PREP_ITEMS = [
  ['cobb', 'Cobb Salad'], ['market', 'Market Salad'], ['southwest', 'Southwest Salad'],
  ['side', 'Side Salad'], ['kale-cupped', 'Kale (cupped)'], ['small-fruit', 'Small Fruit'],
  ['medium-fruit', 'Med Fruit'], ['large-fruit', 'Large Fruit'], ['parfait', 'Parfait'],
  ['grilled-wrap', 'Grilled Wrap'], ['veggie-wrap', 'Veggie Wrap'], ['cookies', 'Cookies'],
  ['brownies', 'Brownies'], ['bacon-strips', 'Bacon (strips)'], ['eggs', 'Eggs'],
  ['tea', 'Sweet Tea'],
] as const;

export type PrepValues = Record<string, number | null>;
export interface SaturdayPrepRecord {
  storeId: string;
  dayKey: string;
  values: PrepValues;
  updatedBy: string;
  updatedAt: Timestamp | null;
  submittedAt?: Timestamp | null;
}

// The store's Saturday must not depend on the device's timezone.
export function prepDayKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function isSaturday(value: string): boolean {
  const date = new Date(`${value}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime())
    && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 6;
}

export function latestSaturday(now = new Date()): string {
  const date = new Date(`${prepDayKey(now)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 1) % 7);
  return date.toISOString().slice(0, 10);
}

export function validPrepValue(key: string, value: number | null): boolean {
  const tableField = TABLE_ITEMS.some(([id]) => key === `${id}_lb` || key === `${id}_oz`);
  const prepField = PREP_ITEMS.some(([id]) => key === `${id}_eod` || key === `${id}_left`);
  if (!tableField && !prepField) return false;
  if (value === null) return true;
  if (!Number.isFinite(value) || value < 0 || value > 10000) return false;
  if (key.endsWith('_oz')) return value < 16;
  return key.startsWith('tea_') || Number.isInteger(value);
}

export function prepValidation(values: PrepValues): string[] {
  const errors: string[] = [];
  for (const [id, name] of TABLE_ITEMS) {
    if (values[`${id}_lb`] == null || values[`${id}_oz`] == null) {
      errors.push(`${name}: enter pounds and ounces (use 0 for none).`);
    } else if (!validPrepValue(`${id}_lb`, values[`${id}_lb`]) || !validPrepValue(`${id}_oz`, values[`${id}_oz`])) {
      errors.push(`${name}: use whole pounds and ounces from 0 to less than 16.`);
    }
  }
  for (const [id, name] of PREP_ITEMS) {
    const eod = values[`${id}_eod`];
    const left = values[`${id}_left`];
    if (eod == null || left == null) errors.push(`${name}: enter both quantities (use 0 for none).`);
    else if (!validPrepValue(`${id}_eod`, eod) || !validPrepValue(`${id}_left`, left)) {
      errors.push(`${name}: enter valid nonnegative ${id === 'tea' ? 'gallons' : 'whole counts'}.`);
    } else if (left > eod) errors.push(`${name}: left at 11 p.m. cannot exceed the 10 p.m. quantity.`);
  }
  return errors;
}

export function promoFree(values: PrepValues, id: string): number | null {
  const eod = values[`${id}_eod`];
  const left = values[`${id}_left`];
  return eod == null || left == null || !validPrepValue(`${id}_eod`, eod)
    || !validPrepValue(`${id}_left`, left) || left > eod ? null : Number((eod - left).toFixed(10));
}

export function prepTotals(values: PrepValues) {
  return {
    tableOunces: TABLE_ITEMS.reduce((sum, [id]) => sum + (values[`${id}_lb`] ?? 0) * 16 + (values[`${id}_oz`] ?? 0), 0),
    wastedEach: PREP_ITEMS.filter(([id]) => id !== 'tea').reduce((sum, [id]) => sum + (values[`${id}_left`] ?? 0), 0),
    promoEach: PREP_ITEMS.filter(([id]) => id !== 'tea').reduce((sum, [id]) => sum + (promoFree(values, id) ?? 0), 0),
    wastedGallons: values.tea_left ?? 0,
    promoGallons: promoFree(values, 'tea') ?? 0,
  };
}
