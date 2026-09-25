import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { Timestamp } from 'firebase/firestore';
import { isSaturday, latestSaturday, PREP_ITEMS, prepDayKey, prepTotals, prepValidation, promoFree, TABLE_ITEMS, validPrepValue, type PrepValues, type SaturdayPrepRecord } from './saturdayPrep';
import { createSaturdayPrepWorkbook } from './saturdayPrepWorkbook';

function completedValues(): PrepValues {
  return Object.fromEntries([
    ...TABLE_ITEMS.flatMap(([id]) => [[`${id}_lb`, 0], [`${id}_oz`, 0]]),
    ...PREP_ITEMS.flatMap(([id]) => [[`${id}_eod`, 0], [`${id}_left`, 0]]),
  ]);
}

describe('Saturday closing reconciliation', () => {
  it('takes 11 p.m. leftovers as waste and the difference as Promo Free', () => {
    const values = { ...completedValues(), cobb_eod: 10, cobb_left: 3, tea_eod: 2.5, tea_left: .75,
      romaine_lb: 2, romaine_oz: 8, apples_lb: 1, apples_oz: 12 };
    expect(prepValidation(values)).toEqual([]);
    expect(promoFree(values, 'cobb')).toBe(7);
    expect(prepTotals(values)).toEqual({ tableOunces: 68, wastedEach: 3, promoEach: 7, wastedGallons: .75, promoGallons: 1.75 });
  });

  it('distinguishes missing fields from explicit zeros', () => {
    expect(prepValidation({})).toHaveLength(30);
    expect(promoFree({ cobb_eod: 10 }, 'cobb')).toBeNull();
    expect(prepValidation(completedValues())).toEqual([]);
    expect(prepValidation({ ...completedValues(), cobb_left: null })).toHaveLength(1);
    expect(promoFree({ cobb_eod: 0, cobb_left: 0 }, 'cobb')).toBe(0);
  });

  it('rejects negative, fractional each, oversized ounces, and impossible leftovers', () => {
    for (const [key, value] of [['cobb_eod', -1], ['cobb_eod', 1.5], ['romaine_oz', 16], ['romaine_lb', .5], ['tea_eod', Infinity], ['unknown', 1]] as const) {
      expect(validPrepValue(key, value)).toBe(false);
    }
    const values = { ...completedValues(), cobb_eod: 3, cobb_left: 10 };
    expect(prepValidation(values)).toEqual(['Cobb Salad: left at 11 p.m. cannot exceed the 10 p.m. quantity.']);
    expect(promoFree(values, 'cobb')).toBeNull();
    expect(validPrepValue('tea_eod', 1.5)).toBe(true);
    expect(validPrepValue('romaine_oz', .5)).toBe(true);
  });

  it('uses the store Saturday across UTC midnight and daylight saving changes', () => {
    expect(prepDayKey(new Date('2026-09-27T03:59:00Z'))).toBe('2026-09-26');
    expect(isSaturday(prepDayKey(new Date('2026-09-27T04:00:00Z')))).toBe(false);
    expect(prepDayKey(new Date('2026-12-06T04:59:00Z'))).toBe('2026-12-05');
    expect(latestSaturday(new Date('2026-09-25T18:00:00Z'))).toBe('2026-09-19');
    expect(latestSaturday(new Date('2026-09-26T18:00:00Z'))).toBe('2026-09-26');
    expect(isSaturday('2026-02-30')).toBe(false);
    expect(isSaturday('')).toBe(false);
  });

  it('exports range totals per item, carries ounces, and excludes drafts and out-of-range logs', async () => {
    const base: SaturdayPrepRecord = { storeId: '00756', dayKey: '2026-09-12', updatedBy: 'test', updatedAt: null,
      submittedAt: Timestamp.fromMillis(1), values: { ...completedValues(), cobb_eod: 10, cobb_left: 3, romaine_lb: 2, romaine_oz: 12, tea_eod: 2.5, tea_left: .75 } };
    const records = [base, { ...base, dayKey: '2026-09-19' },
      { ...base, dayKey: '2026-09-26', submittedAt: null, values: { cobb_eod: 400 } },
      { ...base, dayKey: '2026-08-29' }];
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await createSaturdayPrepWorkbook(records, '2026-09-01', '2026-09-30'));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Table weights', 'Prepared items']);
    const table = workbook.getWorksheet('Table weights')!;
    const prep = workbook.getWorksheet('Prepared items')!;
    expect(table.getCell('A3').value).toBe('2 submitted Saturday log(s) included · 1 draft or incomplete log(s) excluded');
    expect(table.getRow(7).values).toEqual([undefined, 'Chopped Romaine', 5.5, 5, 8]);
    expect(prep.getRow(5).values).toEqual([undefined, 'Cobb Salad', 'each', 6, 14]);
    expect(prep.getRow(20).values).toEqual([undefined, 'Sweet Tea', 'gal', 1.5, 3.5]);
    expect(table.rowCount).toBe(18);
    expect(prep.rowCount).toBe(20);
    await expect(createSaturdayPrepWorkbook([records[2]], '2026-09-01', '2026-09-30')).rejects.toThrow('No completed, submitted');
  });
});
