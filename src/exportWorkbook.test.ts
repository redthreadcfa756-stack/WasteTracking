import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './defaults';
import { buildWasteTrend } from './domain';
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
      startDayKey: '2026-08-03',
      endDayKey: '2026-08-08',
      source: 'live',
      metric: 'quantity',
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const daily = workbook.getWorksheet('Daily Waste Cost');
    expect(daily?.getRow(4).values).toEqual([
      undefined,
      'Day',
      'Date',
      'Total Cost',
      'Highest Contributing Item',
    ]);
    expect(daily?.getCell('D5').value).toBe('Filets');
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
    expect(matrix?.getCell(projectionRow, filetColumn).value).toBeCloseTo(0.1);
    expect(matrix?.getCell(projectionRow + 1, filetColumn).value).toBeCloseTo(0.6);
    expect(matrix?.getCell(projectionRow + 2, filetColumn).value).toBeCloseTo(2.6);
  });
});
