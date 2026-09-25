import { Timestamp } from 'firebase/firestore';
import { PREP_ITEMS, TABLE_ITEMS, type PrepValues, type SaturdayPrepRecord } from './saturdayPrep';

// Report-only samples: no demo values are written to the store's operational log.
export function createSaturdayPrepDemoRecords(storeId: string, start: string, end: string): SaturdayPrepRecord[] {
  const first = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
    || !Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime())
    || first.toISOString().slice(0, 10) !== start || last.toISOString().slice(0, 10) !== end || start > end) {
    throw new Error('Choose a valid starting date on or before the ending date.');
  }
  first.setUTCDate(first.getUTCDate() + (6 - first.getUTCDay() + 7) % 7);
  const records: SaturdayPrepRecord[] = [];
  for (const date = new Date(first); date <= last; date.setUTCDate(date.getUTCDate() + 7)) {
    const week = Math.abs(Math.floor(date.getTime() / (7 * 24 * 60 * 60 * 1000)));
    const values: PrepValues = {};
    TABLE_ITEMS.forEach(([id], index) => {
      values[`${id}_lb`] = (week + index * 3) % 5;
      values[`${id}_oz`] = (week * 3 + index * 5) % 16;
    });
    PREP_ITEMS.forEach(([id], index) => {
      const eod = (week + index * 3) % 13;
      const left = (week + index) % (eod + 1);
      values[`${id}_eod`] = id === 'tea' ? eod / 4 : eod;
      values[`${id}_left`] = id === 'tea' ? left / 4 : left;
    });
    const dayKey = date.toISOString().slice(0, 10);
    const submittedAt = Timestamp.fromDate(new Date(`${dayKey}T23:00:00Z`));
    records.push({ storeId, dayKey, values, updatedBy: 'DEMO', updatedAt: submittedAt, submittedAt });
  }
  return records;
}
