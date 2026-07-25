import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './defaults';
import { buildDonationCsv, buildWasteCsv, detectDaypart, distributeDollarTarget, donationPrediction, formatDurationInput, mergeActivity, parseDuration } from './domain';
import type { DonationRecord, WasteEvent } from './types';

const event = (overrides: Partial<WasteEvent>): WasteEvent => ({
  id: 'event', storeId: 'store', productId: 'filets', productName: 'Filets', equivalentUnits: 1,
  displayQuantity: 1, displayUnit: 'each', unitCostSnapshot: 2, eventAt: new Date('2026-07-23T09:26:15'),
  dayKey: '2026-07-23', daypartId: 'breakfast', menu: 'breakfast', deviceName: 'iPhone',
  createdBy: 'uid', createdByName: 'CL', ...overrides,
});

describe('domain rules', () => {
  it('uses the requested daypart boundaries', () => {
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 10, 29))).toBe('breakfast');
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 10, 30))).toBe('lunch');
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 14, 0))).toBe('afternoon');
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 17, 0))).toBe('early-dinner');
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 19, 0))).toBe('late-dinner');
  });

  it('merges repeated taps by product and minute', () => {
    const merged = mergeActivity([
      event({ id: 'a', equivalentUnits: 1, displayQuantity: 1 }),
      event({ id: 'b', equivalentUnits: 1, displayQuantity: 1, eventAt: new Date('2026-07-23T09:26:45') }),
    ], DEFAULT_SETTINGS.products);
    expect(merged).toHaveLength(1);
    expect(merged[0].displayQuantity).toBe(2);
  });

  it('predicts donations from previous non-breakfast plus current breakfast waste', () => {
    const item = DEFAULT_SETTINGS.donationItems.find((candidate) => candidate.id === 'filet-total')!;
    const predicted = donationPrediction(
      item,
      DEFAULT_SETTINGS,
      [event({ productId: 'filets', equivalentUnits: 8, daypartId: 'lunch' })],
      [event({ productId: 'breakfast-filets', equivalentUnits: 2, daypartId: 'breakfast' })],
    );
    expect(predicted).toBeCloseTo(4.7);
  });

  it('parses SOS minute-second values', () => {
    expect(parseDuration('4:18')).toBe(258);
    expect(parseDuration('4:90')).toBeNull();
  });

  it('formats typed SOS digits as minutes and seconds', () => {
    expect(formatDurationInput('4')).toBe('0:04');
    expect(formatDurationInput('45')).toBe('0:45');
    expect(formatDurationInput('123')).toBe('1:23');
    expect(formatDurationInput('4:18')).toBe('4:18');
  });

  it('exports net waste grouped by daypart', () => {
    const csv = buildWasteCsv([
      event({ id: 'a', productId: 'filets', equivalentUnits: 2, unitCostSnapshot: 2, daypartId: 'lunch' }),
      event({ id: 'b', productId: 'filets', equivalentUnits: -1, unitCostSnapshot: 2, daypartId: 'lunch' }),
    ], DEFAULT_SETTINGS, 'daypart', '2026-07-23');
    expect(csv).toContain('Lunch,Product detail,Filets,1,1,YES,YES');
  });

  it('calculates daily averages for a waste export range', () => {
    const csv = buildWasteCsv([
      event({ id: 'a', equivalentUnits: 20, unitCostSnapshot: 2, dayKey: '2026-07-01' }),
      event({ id: 'b', equivalentUnits: 10, unitCostSnapshot: 2, dayKey: '2026-07-02' }),
    ], DEFAULT_SETTINGS, 'hour', '2026-07-01', '2026-07-30', 30);
    expect(csv).toContain('Product detail,Filets,1,1,YES,YES');
  });

  it('ranks both a product’s top times and a time’s top products', () => {
    const csv = buildWasteCsv([
      event({ id: 'a', productId: 'filets', productName: 'Filets', equivalentUnits: 5, unitCostSnapshot: 2, eventAt: new Date('2026-07-23T09:10:00') }),
      event({ id: 'b', productId: 'filets', productName: 'Filets', equivalentUnits: 2, unitCostSnapshot: 2, eventAt: new Date('2026-07-23T10:10:00') }),
      event({ id: 'c', productId: 'spicy', productName: 'Spicy filets', equivalentUnits: 2, unitCostSnapshot: 3, eventAt: new Date('2026-07-23T09:20:00') }),
    ], DEFAULT_SETTINGS, 'hour', '2026-07-23');
    expect(csv).toContain('09:00-09:59,Product detail,Filets,1,1,YES,YES');
    expect(csv).toContain('10:00-10:59,Product detail,Filets,2,1,YES,YES');
    expect(csv).toContain('09:00-09:59,Product detail,Spicy filets,1,2,YES,YES');
  });

  it('exports only total submitted donation actuals', () => {
    const record = (day: string, actual: number): DonationRecord => ({
      storeId: '00756',
      dayKey: day,
      actuals: { 'filet-donation': actual },
      predictions: { 'filet-donation': 2 },
      units: { 'filet-donation': 'lb' },
      variance: { 'filet-donation': actual - 2 },
      initials: 'CL',
      submittedAt: new Date(),
      submittedBy: 'uid',
      submittedByName: 'Store team',
      revision: 1,
    });
    const csv = buildDonationCsv([
      record('2026-07-01', 4),
      record('2026-07-02', 6),
    ], DEFAULT_SETTINGS, '2026-07-01', '2026-07-30', 30);
    expect(csv).toContain('Filet,lb,10');
  });

  it('distributes a whole daypart target to the same dollar total', () => {
    const lunch = DEFAULT_SETTINGS.dayparts.find((part) => part.id === 'lunch')!;
    const products = DEFAULT_SETTINGS.products.filter((product) => product.menus.includes('lunch'));
    const result = distributeDollarTarget(products, lunch, 60);
    const total = products.reduce((sum, product) => {
      const factor = product.trackingUnit === 'cup' ? (product.unitsPerCup || 1) : 1;
      return sum + result[product.id] * factor * product.unitCost;
    }, 0);
    expect(total).toBeCloseTo(60);
  });
});
