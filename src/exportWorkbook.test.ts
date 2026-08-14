import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './defaults';
import { buildUsageRangeReport, buildWasteTrend } from './domain';
import { createWasteTrendWorkbook } from './exportWorkbook';
import type { WasteEvent } from './types';

const wasteEvent = (overrides: Partial<WasteEvent>): WasteEvent => ({
  id: 'event',
  storeId: 'store',
  productId: 'filets',
  productName: 'Filets',
  equivalentUnits: 1,
  displayQuantity: 1,
  displayUnit: 'each',
  unitCostSnapshot: 2,
  eventAt: new Date('2026-08-03T11:00:00'),
  dayKey: '2026-08-03',
  daypartId: 'lunch',
  menu: 'lunch',
  deviceName: 'iPad',
  createdBy: 'uid',
  createdByName: 'CL',
  ...overrides,
});

describe('cool down workbook', () => {
  it('exports the requested daily columns and case projection rows', async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      products: DEFAULT_SETTINGS.products.map((product) => product.id === 'filets' ? {
        ...product,
        averageWeightLb: 0.5,
        perUnitWeight: 0.5,
        perUnitWeightUnit: 'lb' as const,
        caseWeightLb: 10,
      } : product),
    };
    const events = [
      wasteEvent({ id: 'filets', equivalentUnits: 12 }),
      wasteEvent({
        id: 'spicy',
        productId: 'spicy',
        productName: 'Spicy filets',
        equivalentUnits: 1,
        unitCostSnapshot: 3,
      }),
    ];
    const buffer = await createWasteTrendWorkbook({
      events,
      trend: buildWasteTrend(events, settings, 'hour'),
      settings,
      grouping: 'hour',
      startDayKey: '2026-08-01',
      endDayKey: '2026-08-10',
      source: 'live',
      metric: 'quantity',
      usageReport: buildUsageRangeReport({
        settings,
        startDayKey: '2026-08-01',
        endDayKey: '2026-08-10',
        now: new Date('2026-08-11T12:00:00'),
        wasteEvents: events,
        donationRecords: [],
        usageRecords: [],
      }),
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const daily = workbook.getWorksheet('Daily Waste Cost');
    expect(daily?.getRow(4).values).toEqual([
      undefined,
      'Day',
      'Dates Averaged',
      'Average Cost',
      'Highest Contributing Item',
    ]);
    expect(daily?.getCell('A5').value).toBe('Monday');
    expect(daily?.getCell('B5').value).toBe('2 dates: 8/3/26–8/10/26');
    expect(daily?.getCell('C5').value).toBeCloseTo(13.5);
    expect(daily?.getCell('D5').value).toBe('Filets');
    const weekdayRows = Array.from({ length: 6 }, (_, index) => daily?.getCell(index + 5, 1).value);
    expect(weekdayRows.filter((day) => day === 'Monday')).toHaveLength(1);
    expect(weekdayRows).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
    let daypartSummaryRow = 0;
    daily?.eachRow((row, rowNumber) => {
      if (row.getCell(1).value === 'Top Wasted Item by Daypart — Selected Period') daypartSummaryRow = rowNumber;
    });
    expect(daypartSummaryRow).toBeGreaterThan(0);
    expect(daily?.getRow(daypartSummaryRow + 1).values).toEqual([
      undefined,
      'Daypart',
      'Top Wasted Item',
      'Contributing Cost',
    ]);
    const lunchSummaryRow = settings.dayparts.findIndex((daypart) => daypart.id === 'lunch') + daypartSummaryRow + 2;
    expect(daily?.getCell(lunchSummaryRow, 2).value).toBe('Filets');
    expect(daily?.getCell(lunchSummaryRow, 3).value).toBe(24);

    const matrix = workbook.getWorksheet('Product by Time');
    let projectionRow = 0;
    matrix?.eachRow((row, rowNumber) => {
      if (row.getCell(1).value === 'Projected cases / operating day') projectionRow = rowNumber;
    });
    const filetColumn = settings.products.findIndex((product) => product.id === 'filets') + 2;
    expect(projectionRow).toBeGreaterThan(0);
    expect(matrix?.getCell(projectionRow, filetColumn).value).toBeCloseTo(0.075);
    expect(matrix?.getCell(projectionRow + 1, filetColumn).value).toBeCloseTo(0.45);
    expect(matrix?.getCell(projectionRow + 2, filetColumn).value).toBeCloseTo(1.95);

    const usage = workbook.getWorksheet('Usage Confidence');
    expect(usage?.getRow(6).values).toEqual([
      undefined,
      'Usage Date',
      'Finalizing Donation Date',
      'Usage Score',
      'Confidence',
      'Presence',
      'Continuity',
      'Donation Reconciliation',
      'Notes',
    ]);
    expect(usage?.getCell('D7').value).toBe('Awaiting donation');
  });
});
