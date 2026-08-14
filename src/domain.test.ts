import { describe, expect, it } from 'vitest';
import { COOLDOWN_PANS, DEFAULT_PRODUCTS, DEFAULT_SETTINGS, PRODUCT_TONES } from './defaults';
import {
  adjustCooldownProductQuantities,
  buildDailyWasteSummary,
  buildDailyWasteCosts,
  buildDaypartTopWasteItems,
  buildDaypartTopWasteItemsFromDailySummaries,
  buildDonationCsv,
  buildProductCaseProjections,
  buildUsageScore,
  buildWasteCsv,
  buildWeekdayWasteCosts,
  cooldownProductQuantity,
  currentUsagePresenceSlot,
  daypartWaste,
  detectDaypart,
  distributeDollarTarget,
  donationPrediction,
  donationWindowDayKeys,
  formatDurationInput,
  mergeActivity,
  operatingDayCount,
  parseDonationEntry,
  parseDuration,
  pendingQuantityAfterServerUpdate,
  quantityAdjustmentFromDrag,
  targetCasesForProduct,
  targetDollarForProduct,
  usagePresenceSlotKey,
  wasteExportPresetRange,
  weightToPounds,
  withDerivedProductPricing,
} from './domain';
import type { CooldownTimer, DiscardEvent, DonationItemConfig, DonationRecord, UsageDayRecord, WasteEvent } from './types';

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

  it('configures fries as a discard-only large serving measured at 6.15 ounces', () => {
    const fries = DEFAULT_PRODUCTS.find((product) => product.id === 'fries');
    expect(fries).toMatchObject({
      name: 'Large fries',
      menus: ['lunch'],
      trackingUnit: 'each',
      tapQuantity: 1,
      perUnitWeight: 6.15,
      perUnitWeightUnit: 'oz',
      discardOnly: true,
    });
    expect(COOLDOWN_PANS.some((pan) => pan.productIds.includes('fries'))).toBe(false);
  });

  it('uses the requested daypart boundaries', () => {
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 10, 29))).toBe('breakfast');
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 10, 30))).toBe('lunch');
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 14, 0))).toBe('afternoon');
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 17, 0))).toBe('early-dinner');
    expect(detectDaypart(DEFAULT_SETTINGS.dayparts, new Date(2026, 6, 23, 19, 0))).toBe('late-dinner');
  });

  it('identifies the current 15-minute usage presence slot', () => {
    expect(currentUsagePresenceSlot(DEFAULT_SETTINGS.dayparts, new Date(2026, 7, 4, 10, 37))).toEqual({
      daypartId: 'lunch',
      slotKey: 'lunch_0630',
    });
    expect(currentUsagePresenceSlot(DEFAULT_SETTINGS.dayparts, new Date(2026, 7, 4, 23, 0))).toBeNull();
  });

  it('requires donation evidence before a complete tracking day is statistics eligible', () => {
    const activeSlotKeys = [
      ...Array.from({ length: 16 }, (_, index) => usagePresenceSlotKey('breakfast', 390 + index * 15)),
      usagePresenceSlotKey('lunch', 630),
    ];
    const usageRecord: UsageDayRecord = {
      storeId: '00756',
      dayKey: '2026-08-04',
      activeSlotKeys,
      zeroWasteDaypartIds: [],
      updatedAt: new Date(),
    };
    const currentWaste = [7, 8, 9, 10].map((hour, index) => event({
      id: `breakfast-${index}`,
      dayKey: '2026-08-04',
      productId: 'breakfast-filets',
      productName: 'Breakfast filets',
      equivalentUnits: 1,
      daypartId: 'breakfast',
      eventAt: new Date(2026, 7, 4, hour, 5),
    }));
    const result = buildUsageScore({
      settings: DEFAULT_SETTINGS,
      selectedDayKey: '2026-08-04',
      now: new Date(2026, 7, 4, 10, 31),
      currentWaste,
      previousWaste: [],
      donationRecord: null,
      usageRecord,
    });
    expect(result.score).toBe(100);
    expect(result.status).toBe('provisional');
    expect(result.reportEligible).toBe(false);
  });

  it('marks unconfirmed empty dayparts and donation under-reporting as unreliable', () => {
    const donationRecord: DonationRecord = {
      storeId: '00756',
      dayKey: '2026-08-04',
      actuals: { 'breakfast-filet-donation': 10 },
      predictions: {},
      units: { 'breakfast-filet-donation': 'lb' },
      variance: {},
      initials: 'CL',
      submittedAt: new Date(),
      submittedBy: 'uid',
      submittedByName: 'Store team',
      revision: 1,
    };
    const result = buildUsageScore({
      settings: DEFAULT_SETTINGS,
      selectedDayKey: '2026-08-04',
      now: new Date(2026, 7, 4, 14, 1),
      currentWaste: [event({
        id: 'one-filet',
        dayKey: '2026-08-04',
        productId: 'breakfast-filets',
        productName: 'Breakfast filets',
        equivalentUnits: 1,
        daypartId: 'breakfast',
        eventAt: new Date(2026, 7, 4, 7, 5),
      })],
      previousWaste: [],
      donationRecord,
      usageRecord: null,
    });
    expect(result.donationScore).toBeLessThan(10);
    expect(result.dayparts.find((daypart) => daypart.daypartId === 'lunch')?.needsUsageReview).toBe(true);
    expect(result.reportEligible).toBe(false);
    expect(result.status).toBe('unreliable');
  });

  it('records known missed and uncertain empty dayparts as explicit usage failures', () => {
    const baseUsageRecord: UsageDayRecord = {
      storeId: '00756',
      dayKey: '2026-08-04',
      activeSlotKeys: [],
      zeroWasteDaypartIds: [],
      missedWasteDaypartIds: ['lunch'],
      uncertainWasteDaypartIds: ['breakfast'],
      updatedAt: new Date(),
    };
    const result = buildUsageScore({
      settings: DEFAULT_SETTINGS,
      selectedDayKey: '2026-08-04',
      now: new Date(2026, 7, 4, 14, 1),
      currentWaste: [],
      previousWaste: [],
      donationRecord: null,
      usageRecord: baseUsageRecord,
    });
    const breakfast = result.dayparts.find((daypart) => daypart.daypartId === 'breakfast');
    const lunch = result.dayparts.find((daypart) => daypart.daypartId === 'lunch');
    expect(breakfast).toMatchObject({ uncertainWaste: true, needsUsageReview: false, continuityScore: 0 });
    expect(lunch).toMatchObject({ missedWaste: true, needsUsageReview: false, continuityScore: 0 });
    expect(result.reasons).toContain('Breakfast: Team could not confirm whether the empty daypart was accurate');
    expect(result.reasons).toContain('Lunch: Team reported that waste occurred but was not logged');
    expect(result.reportEligible).toBe(false);
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
    expect(DEFAULT_SETTINGS.alarmVoiceVolume).toBe(1);
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

  it('keeps rapid taps visible until the pan snapshot catches up', () => {
    expect(pendingQuantityAfterServerUpdate(3, 4, 5)).toBe(2);
    expect(pendingQuantityAfterServerUpdate(2, 5, 7)).toBe(0);
    expect(pendingQuantityAfterServerUpdate(-3, 5, 4)).toBe(-2);
    expect(pendingQuantityAfterServerUpdate(-2, 4, 2)).toBe(0);
    expect(pendingQuantityAfterServerUpdate(2, 4, 3)).toBe(2);
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

  it('uses the selected donation date and its previous day for reconciliation', () => {
    expect(donationWindowDayKeys('2026-08-04')).toEqual({
      current: '2026-08-04',
      previous: '2026-08-03',
    });
    expect(donationWindowDayKeys('2026-01-01').previous).toBe('2025-12-31');
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

  it('calculates raw daily waste costs across every selected operating day', () => {
    const daily = buildDailyWasteCosts([
      event({ id: 'a', productId: 'filets', productName: 'Filets', dayKey: '2026-07-01', equivalentUnits: 2, unitCostSnapshot: 3 }),
      event({ id: 'b', productId: 'spicy', productName: 'Spicy filets', dayKey: '2026-07-01', equivalentUnits: 1, unitCostSnapshot: 4 }),
      event({ id: 'c', dayKey: '2026-07-03', equivalentUnits: 5, unitCostSnapshot: 2 }),
    ], '2026-07-01', '2026-07-03');
    expect(daily).toEqual([
      { dayKey: '2026-07-01', totalCost: 10, entries: 2, highestContributingItem: 'Filets' },
      { dayKey: '2026-07-02', totalCost: 0, entries: 0, highestContributingItem: '' },
      { dayKey: '2026-07-03', totalCost: 10, entries: 1, highestContributingItem: 'Filets' },
    ]);
  });

  it('uses Monday through Saturday for export presets and operating-day counts', () => {
    expect(wasteExportPresetRange('week-to-date', '2026-08-13')).toEqual({
      startDayKey: '2026-08-10',
      endDayKey: '2026-08-13',
    });
    expect(wasteExportPresetRange('previous-week', '2026-08-13')).toEqual({
      startDayKey: '2026-08-03',
      endDayKey: '2026-08-08',
    });
    expect(wasteExportPresetRange('month-to-date', '2026-08-13')).toEqual({
      startDayKey: '2026-08-01',
      endDayKey: '2026-08-13',
    });
    expect(operatingDayCount('2026-08-01', '2026-08-09')).toBe(7);
  });

  it('projects product cases from every selected operating day and excludes Sundays', () => {
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
    const projection = buildProductCaseProjections([
      event({ id: 'a', dayKey: '2026-08-03', equivalentUnits: 6 }),
      event({ id: 'b', dayKey: '2026-08-08', equivalentUnits: 6 }),
      event({ id: 'sunday', dayKey: '2026-08-09', equivalentUnits: 100 }),
    ], settings, '2026-08-03', '2026-08-09').find((entry) => entry.productId === 'filets');

    expect(projection).toMatchObject({ operatingDays: 6, operatingDaysInMonth: 26 });
    expect(projection?.totalCases).toBeCloseTo(0.6);
    expect(projection?.casesPerDay).toBeCloseTo(0.1);
    expect(projection?.casesPerWeek).toBeCloseTo(0.6);
    expect(projection?.casesPerMonth).toBeCloseTo(2.6);
  });

  it('omits Sundays from daily waste cost rows', () => {
    const daily = buildDailyWasteCosts([
      event({ id: 'sunday', dayKey: '2026-08-09', equivalentUnits: 10 }),
      event({ id: 'monday', dayKey: '2026-08-10', equivalentUnits: 2 }),
    ], '2026-08-09', '2026-08-10');
    expect(daily.map((day) => day.dayKey)).toEqual(['2026-08-10']);
    expect(daily[0].totalCost).toBe(4);
  });

  it('averages repeated weekdays into one Monday-through-Saturday row', () => {
    const weekdays = buildWeekdayWasteCosts([
      event({ id: 'monday-one', dayKey: '2026-08-03', equivalentUnits: 5, unitCostSnapshot: 2 }),
      event({ id: 'monday-two', dayKey: '2026-08-10', equivalentUnits: 15, unitCostSnapshot: 2 }),
      event({ id: 'saturday-one', dayKey: '2026-08-01', equivalentUnits: 4, unitCostSnapshot: 2 }),
      event({ id: 'sunday', dayKey: '2026-08-09', equivalentUnits: 100, unitCostSnapshot: 2 }),
    ], '2026-08-01', '2026-08-10');

    expect(weekdays.map((day) => day.dayLabel)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday',
    ]);
    expect(weekdays.find((day) => day.dayLabel === 'Monday')).toMatchObject({
      dayKeys: ['2026-08-03', '2026-08-10'],
      occurrenceCount: 2,
      totalCost: 40,
      averageCost: 20,
      highestContributingItem: 'Filets',
    });
    expect(weekdays.find((day) => day.dayLabel === 'Saturday')).toMatchObject({
      dayKeys: ['2026-08-01', '2026-08-08'],
      occurrenceCount: 2,
      totalCost: 8,
      averageCost: 4,
    });
  });

  it('finds the highest-cost wasted item in each daypart for the selected period', () => {
    const summaries = buildDaypartTopWasteItems([
      event({ id: 'breakfast-filets', dayKey: '2026-08-03', daypartId: 'breakfast', equivalentUnits: 3, unitCostSnapshot: 2 }),
      event({ id: 'lunch-filets', dayKey: '2026-08-03', daypartId: 'lunch', equivalentUnits: 2, unitCostSnapshot: 2 }),
      event({ id: 'lunch-spicy', productId: 'spicy', productName: 'Spicy filets', dayKey: '2026-08-04', daypartId: 'lunch', equivalentUnits: 2, unitCostSnapshot: 3 }),
      event({ id: 'sunday', productId: 'nuggets', productName: 'Nuggets', dayKey: '2026-08-09', daypartId: 'lunch', equivalentUnits: 100, unitCostSnapshot: 3 }),
    ], DEFAULT_SETTINGS, '2026-08-03', '2026-08-09');

    expect(summaries.find((summary) => summary.daypartId === 'breakfast')).toMatchObject({
      productName: 'Filets',
      totalCost: 6,
    });
    expect(summaries.find((summary) => summary.daypartId === 'lunch')).toMatchObject({
      productName: 'Spicy filets',
      totalCost: 6,
    });
    expect(summaries.find((summary) => summary.daypartId === 'afternoon')).toMatchObject({
      productId: null,
      productName: '',
      totalCost: 0,
    });
  });

  it('builds completed-day summaries and ranks month-to-date waste without individual events', () => {
    const monday = buildDailyWasteSummary([
      event({ id: 'filets-add', dayKey: '2026-08-03', daypartId: 'breakfast', equivalentUnits: 3, unitCostSnapshot: 2 }),
      event({ id: 'filets-adjust', dayKey: '2026-08-03', daypartId: 'breakfast', equivalentUnits: -1, unitCostSnapshot: 2 }),
      event({ id: 'spicy', productId: 'spicy', productName: 'Spicy filets', dayKey: '2026-08-03', daypartId: 'lunch', equivalentUnits: 2, unitCostSnapshot: 3 }),
    ], '00756', '2026-08-03', 'uid');
    const tuesday = buildDailyWasteSummary([
      event({ id: 'more-spicy', productId: 'spicy', productName: 'Spicy filets', dayKey: '2026-08-04', daypartId: 'lunch', equivalentUnits: 2, unitCostSnapshot: 3 }),
    ], '00756', '2026-08-04', 'uid');
    const sunday = buildDailyWasteSummary([
      event({ id: 'ignored', dayKey: '2026-08-09', equivalentUnits: 100, unitCostSnapshot: 10 }),
    ], '00756', '2026-08-09', 'uid');

    expect(monday).toMatchObject({ sourceEventCount: 3, computedAt: null, computedBy: 'uid' });
    expect(monday.items.find((item) => item.productId === 'filets')).toMatchObject({ totalCost: 4 });
    expect(sunday).toMatchObject({ sourceEventCount: 0, items: [] });

    const leaders = buildDaypartTopWasteItemsFromDailySummaries([monday, tuesday, sunday], DEFAULT_SETTINGS);
    expect(leaders.find((summary) => summary.daypartId === 'breakfast')).toMatchObject({
      productName: 'Filets',
      totalCost: 4,
    });
    expect(leaders.find((summary) => summary.daypartId === 'lunch')).toMatchObject({
      productName: 'Spicy filets',
      totalCost: 12,
    });
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
