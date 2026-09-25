import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createSaturdayPrepDemoRecords } from './saturdayPrepDemo';
import { prepValidation, promoFree } from './saturdayPrep';
import { createSaturdayPrepWorkbook } from './saturdayPrepWorkbook';

describe('Saturday Prep demo reports', () => {
  it('generates complete, varied Saturday logs within the selected range', () => {
    const records = createSaturdayPrepDemoRecords('00756', '2026-09-01', '2026-09-30');
    expect(records.map((record) => record.dayKey)).toEqual(['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26']);
    for (const record of records) {
      expect(prepValidation(record.values)).toEqual([]);
      expect(record.submittedAt).toBeTruthy();
      expect(promoFree(record.values, 'cobb')).toBe(record.values.cobb_eod! - record.values.cobb_left!);
      expect(promoFree(record.values, 'tea')).toBe(record.values.tea_eod! - record.values.tea_left!);
    }
    expect(records[0].values).not.toEqual(records[1].values);
    expect(createSaturdayPrepDemoRecords('00756', '2026-09-12', '2026-09-12')[0]).toEqual(records[1]);
  });

  it('includes a selected Saturday and produces no data when the range has none', () => {
    expect(createSaturdayPrepDemoRecords('00756', '2026-09-26', '2026-09-26')).toHaveLength(1);
    expect(createSaturdayPrepDemoRecords('00756', '2026-09-20', '2026-09-25')).toEqual([]);
  });

  it('rejects invalid and reversed ranges', () => {
    for (const [start, end] of [['', '2026-09-30'], ['2026-02-30', '2026-03-07'], ['2026-09-30', '2026-09-01']]) {
      expect(() => createSaturdayPrepDemoRecords('00756', start, end)).toThrow('Choose a valid');
    }
  });

  it('labels sample data on every worksheet without changing the live report labels', async () => {
    const records = createSaturdayPrepDemoRecords('00756', '2026-09-26', '2026-09-26');
    const demo = new ExcelJS.Workbook();
    await demo.xlsx.load(await createSaturdayPrepWorkbook(records, '2026-09-26', '2026-09-26', 'demo'));
    expect(demo.getWorksheet('Daily totals')!.getCell('A1').value).toBe('DEMO · Saturday Prep (sample data)');
    expect(demo.getWorksheet('Daily totals')!.getCell('B3').value).toBe('DEMO · Submitted');
    expect(demo.getWorksheet('Table weights')!.getCell('B2').value).toBe('DEMO · Submitted');
    expect(demo.getWorksheet('Prepared items')!.getCell('B2').value).toBe('DEMO · Submitted');
    const live = new ExcelJS.Workbook();
    await live.xlsx.load(await createSaturdayPrepWorkbook(records, '2026-09-26', '2026-09-26'));
    expect(live.getWorksheet('Daily totals')!.getCell('A1').value).toBe('Saturday Prep');
    expect(live.getWorksheet('Prepared items')!.getCell('B2').value).toBe('Submitted');
  });
});
