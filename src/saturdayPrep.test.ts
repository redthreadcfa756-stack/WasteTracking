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

  it('exports per-item detail, separate units, and clearly labeled incomplete drafts', async () => {
    const records: SaturdayPrepRecord[] = [
      { storeId: '00756', dayKey: '2026-09-19', updatedBy: 'test', updatedAt: null,
        submittedAt: Timestamp.fromMillis(1), values: { ...completedValues(), cobb_eod: 10, cobb_left: 3, romaine_lb: 2, romaine_oz: 8, tea_eod: 2.5, tea_left: .75 } },
      { storeId: '00756', dayKey: '2026-09-26', updatedBy: 'test', updatedAt: null, values: { cobb_eod: 4 } },
    ];
    const bytes = await createSaturdayPrepWorkbook(records, '2026-09-01', '2026-09-30');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    expect(workbook.getWorksheet('Daily totals')!.getRow(3).values).toEqual([
      undefined, '2026-09-19', 'Submitted', 2.5, 3, 7, .75, 1.75,
    ]);
    expect(workbook.getWorksheet('Prepared items')!.getRow(2).values).toEqual([
      undefined, '2026-09-19', 'Submitted', 'Cobb Salad', 'each', 10, 3, 7,
    ]);
    const draftRow = workbook.getWorksheet('Prepared items')!.getRow(18);
    expect(draftRow.getCell(2).value).toContain('Draft');
    expect(draftRow.getCell(5).value).toBe(4);
    expect(draftRow.getCell(6).value).toBeNull();
    expect(draftRow.getCell(7).value).toBeNull();
    expect(workbook.getWorksheet('Table weights')!.rowCount).toBe(29);
  });
});
