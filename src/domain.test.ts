import { describe, expect, it } from 'vitest';
import { COOLDOWN_PANS, DEFAULT_SETTINGS, PRODUCT_TONES } from './defaults';
import { adjustCooldownProductQuantities, buildDonationCsv, buildWasteCsv, cooldownProductQuantity, daypartWaste, detectDaypart, distributeDollarTarget, donationPrediction, formatDurationInput, mergeActivity, parseDonationEntry, parseDuration, quantityAdjustmentFromDrag, targetCasesForProduct, targetDollarForProduct, weightToPounds, withDerivedProductPricing } from './domain';
import type { CooldownTimer, DiscardEvent, DonationItemConfig, DonationRecord, WasteEvent } from './types';

const event = (overrides: Partial<WasteEvent>): WasteEvent => ({
  id: 'event', storeId: 'store', productId: 'filets', productName: 'Filets', equivalentUnits: 1,
  displayQuantity: 1, displayUnit: 'each', unitCostSnapshot: 2, eventAt: new Date('2026-07-23T09:26:15'),
  dayKey: '2026-07-23', daypartId: 'breakfast', menu: 'breakfast', deviceName: 'iPhone',
  createdBy: 'uid', createdByName: 'CL', ...overrides,
});

const discardEvent = (overrides: Partial<DiscardEvent>): DiscardEvent => ({
  ...event(overrides),
  reason: 'dropped',
  reasonDetail: '',
  ...overrides,
});

describe('domain rules', () => {
  it('uses the requested protein color mapping', () => {
    expect(PRODUCT_TONES).toMatchObject({
      filets: 1,
      nuggets: 2,
      'grilled-nuggets': 3,
      'grilled-filets': 4,
      spicy: 5,
      'breakfast-filets': 6,
      'breakfast-spicy': 7,
      strips: 8,
    });
  });

  it('assigns every breakfast cool down product to its pan', () => {
    const panForProduct = (productId: string) => (
      COOLDOWN_PANS.find((pan) => pan.productIds.includes(productId))?.id
    );
    expect(panForProduct('grilled-breakfast')).toBe('pan-1');
    expect(panForProduct('sausage')).toBe('pan-1');
    expect(panForProduct('folded-yellow')).toBe('pan-1');
    expect(panForProduct('folded-white')).toBe('pan-1');
    expect(panForProduct('scrambled')).toBe('pan-1');
    expect(panForProduct('nuggets')).toBe('pan-2');
    expect(panForProduct('breakfast-filets')).toBe('pan-3');
    expect(panForProduct('breakfast-spicy')).toBe('pan-4');
  });

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

  it('combines cool down and discard costs in daypart waste', () => {
    const total = daypartWaste([
      event({ id: 'cool-down', equivalentUnits: 1, unitCostSnapshot: 2 }),
      discardEvent({ id: 'discard', equivalentUnits: 2, unitCostSnapshot: 3 }),
    ], 'breakfast');
    expect(total.units).toBe(3);
    expect(total.cost).toBe(8);
  });

  it('defaults shared navigation and card interaction settings', () => {
    expect(DEFAULT_SETTINGS.sosEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.discardTrackingEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.cardScrubEnabled).toBe(true);
  });

  it('maps card drags to signed quantities with a center dead zone', () => {
    expect(quantityAdjustmentFromDrag(9)).toBe(0);
    expect(quantityAdjustmentFromDrag(-9)).toBe(0);
    expect(quantityAdjustmentFromDrag(10)).toBe(1);
    expect(quantityAdjustmentFromDrag(17)).toBe(2);
    expect(quantityAdjustmentFromDrag(-31)).toBe(-4);
    expect(quantityAdjustmentFromDrag(1_000)).toBe(24);
  });

  it('derives unit and cup pricing from case pricing and per-unit weight', () => {
    const nuggets = withDerivedProductPricing({
      ...DEFAULT_SETTINGS.products.find((product) => product.id === 'nuggets')!,
      caseCost: 35,
      caseWeightLb: 10,
      perUnitWeight: 0.04,
      perUnitWeightUnit: 'lb',
    });
    expect(nuggets.unitCost).toBeCloseTo(0.14);
    expect(targetDollarForProduct(nuggets, 1)).toBeCloseTo(1.96);
    expect(targetCasesForProduct(nuggets, 2)).toBeCloseTo(0.112);
  });

  it('normalizes ounces and grams to pounds', () => {
    expect(weightToPounds(1, 'oz')).toBeCloseTo(0.0625);
    expect(weightToPounds(453.59237, 'g')).toBeCloseTo(1);
    expect(weightToPounds(2, 'lb')).toBe(2);
  });

  it('tracks and displays product quantities only for an active cooldown pan', () => {
    const first = adjustCooldownProductQuantities(undefined, 'filets', 2);
    const joined = adjustCooldownProductQuantities(first, 'filets', 3);
    const corrected = adjustCooldownProductQuantities(joined, 'filets', -10);
    expect(joined.filets).toBe(5);
    expect(corrected.filets).toBe(0);

    const timer: CooldownTimer = {
      id: 'pan-3',
      storeId: '00756',
      panLabel: 'Pan 3',
      active: true,
      startedAt: new Date(),
      expiresAt: new Date(),
      lastWasteAt: new Date(),
      joinedWasteCount: 2,
      joinedProductIds: ['filets'],
      productQuantities: joined,
      startedBy: 'uid',
      startedByName: 'Store team',
    };
    expect(cooldownProductQuantity(timer, 'filets')).toBe(5);
    expect(cooldownProductQuantity(timer, 'spicy')).toBe(0);
    expect(cooldownProductQuantity({ ...timer, active: false }, 'filets')).toBeNull();
  });

  it('predicts donations from previous non-breakfast plus current breakfast waste', () => {
    const item: DonationItemConfig = {
      id: 'filet-total',
      name: 'Filet total',
      unit: 'lb',
      sourceProductIds: ['filets', 'breakfast-filets'],
    };
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

  it('fills donation weights right to left without selecting decimals', () => {
    expect(parseDonationEntry('1', 'lb')).toBe(0.01);
    expect(parseDonationEntry('0.012', 'lb')).toBe(0.12);
    expect(parseDonationEntry('0.123', 'lb')).toBe(1.23);
    expect(parseDonationEntry('12.34', 'lb')).toBe(12.34);
    expect(parseDonationEntry('', 'lb')).toBe(0);
    expect(parseDonationEntry('012', 'each')).toBe(12);
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
