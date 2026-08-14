import type {
  AppSettings,
  CooldownTimer,
  DailyWasteSummary,
  DailyWasteSummaryItem,
  DaypartConfig,
  DaypartId,
  DonationItemConfig,
  DonationRecord,
  MergedActivity,
  ProductConfig,
  UsageDayRecord,
  WeightUnit,
  WasteEvent,
} from './types';

export function dayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export type WasteExportPreset = 'week-to-date' | 'previous-week' | 'month-to-date';

function dateFromDayKey(selectedDayKey: string): Date {
  return new Date(`${selectedDayKey}T12:00:00`);
}

export function isOperatingDayKey(selectedDayKey: string): boolean {
  const date = dateFromDayKey(selectedDayKey);
  return Number.isFinite(date.getTime()) && date.getDay() !== 0;
}

export function operatingDayCount(startDayKey: string, endDayKey: string): number {
  const cursor = dateFromDayKey(startDayKey);
  const end = dateFromDayKey(endDayKey);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime()) || cursor > end) return 0;
  let count = 0;
  while (cursor <= end) {
    if (cursor.getDay() !== 0) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

export function operatingDayKeysInRange(startDayKey: string, endDayKey: string): string[] {
  const cursor = dateFromDayKey(startDayKey);
  const end = dateFromDayKey(endDayKey);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime()) || cursor > end) return [];
  const keys: string[] = [];
  while (cursor <= end) {
    if (cursor.getDay() !== 0) keys.push(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

export function wasteExportPresetRange(
  preset: WasteExportPreset,
  endingDayKey: string,
): { startDayKey: string; endDayKey: string } {
  const end = dateFromDayKey(endingDayKey);
  if (!Number.isFinite(end.getTime())) return { startDayKey: '', endDayKey: '' };
  if (end.getDay() === 0) end.setDate(end.getDate() - 1);

  if (preset === 'month-to-date') {
    const start = new Date(end.getFullYear(), end.getMonth(), 1, 12);
    if (start.getDay() === 0) start.setDate(start.getDate() + 1);
    return { startDayKey: dayKey(start), endDayKey: dayKey(end) };
  }

  const currentMonday = new Date(end);
  currentMonday.setDate(currentMonday.getDate() - ((currentMonday.getDay() + 6) % 7));
  if (preset === 'week-to-date') {
    return { startDayKey: dayKey(currentMonday), endDayKey: dayKey(end) };
  }

  const start = new Date(currentMonday);
  start.setDate(start.getDate() - 7);
  const previousSaturday = new Date(start);
  previousSaturday.setDate(previousSaturday.getDate() + 5);
  return { startDayKey: dayKey(start), endDayKey: dayKey(previousSaturday) };
}

export function previousDayKey(date = new Date()): string {
  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return dayKey(previous);
}

export function previousOperatingDayKey(selectedDayKey: string): string {
  const previous = dateFromDayKey(selectedDayKey);
  previous.setDate(previous.getDate() - 1);
  while (previous.getDay() === 0) previous.setDate(previous.getDate() - 1);
  return dayKey(previous);
}

export function nextOperatingDayKey(selectedDayKey: string): string {
  const next = dateFromDayKey(selectedDayKey);
  next.setDate(next.getDate() + 1);
  while (next.getDay() === 0) next.setDate(next.getDate() + 1);
  return dayKey(next);
}

export function donationWindowDayKeys(selectedDayKey: string): { current: string; previous: string } {
  const selectedDate = new Date(`${selectedDayKey}T12:00:00`);
  return {
    current: selectedDayKey,
    previous: previousDayKey(selectedDate),
  };
}

export function detectDaypart(dayparts: DaypartConfig[], date = new Date()): DaypartId {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const matching = dayparts.find((part) => minutes >= part.startMinutes && minutes < part.endMinutes);
  if (matching) return matching.id;
  if (minutes < dayparts[0].startMinutes) return 'breakfast';
  return 'late-dinner';
}

export function adjustCooldownProductQuantities(
  current: Record<string, number> | undefined,
  productId: string,
  equivalentUnits: number,
): Record<string, number> {
  return {
    ...current,
    [productId]: Math.max(0, (current?.[productId] || 0) + equivalentUnits),
  };
}

export function cooldownProductQuantity(
  timer: CooldownTimer | undefined,
  productId: string,
): number | null {
  if (!timer?.active) return null;
  return Math.max(0, timer.productQuantities?.[productId] || 0);
}

export function pendingQuantityAfterServerUpdate(
  pendingQuantity: number,
  previousServerQuantity: number,
  currentServerQuantity: number,
): number {
  const serverChange = currentServerQuantity - previousServerQuantity;
  if (pendingQuantity > 0 && serverChange > 0) {
    return Math.max(0, pendingQuantity - serverChange);
  }
  if (pendingQuantity < 0 && serverChange < 0) {
    return Math.min(0, pendingQuantity - serverChange);
  }
  return pendingQuantity;
}

export function weightToPounds(value: number, unit: WeightUnit): number {
  if (unit === 'oz') return value / 16;
  if (unit === 'g') return value / 453.59237;
  return value;
}

export function withDerivedProductPricing(product: ProductConfig): ProductConfig {
  const averageWeightLb = product.perUnitWeight === undefined
    ? product.averageWeightLb
    : weightToPounds(product.perUnitWeight, product.perUnitWeightUnit || 'lb');
  const hasCasePricing = (product.caseCost || 0) > 0
    && (product.caseWeightLb || 0) > 0
    && averageWeightLb > 0;
  const unitCost = hasCasePricing
    ? (product.caseCost || 0) * (averageWeightLb / (product.caseWeightLb || 1))
    : product.unitCost;

  return {
    ...product,
    averageWeightLb,
    unitCost,
  };
}

export function targetCasesForProduct(
  product: ProductConfig,
  targetQuantity: number,
): number | null {
  if (!product.caseWeightLb || product.caseWeightLb <= 0) return null;
  const equivalentUnits = product.trackingUnit === 'cup'
    ? targetQuantity * (product.unitsPerCup || product.tapQuantity)
    : targetQuantity;
  return equivalentUnits * product.averageWeightLb / product.caseWeightLb;
}

export function quantityAdjustmentFromDrag(
  distance: number,
  {
    deadZonePx = 10,
    pixelsPerQuantity = 7,
    maxQuantity = 24,
  }: {
    deadZonePx?: number;
    pixelsPerQuantity?: number;
    maxQuantity?: number;
  } = {},
): number {
  if (Math.abs(distance) < deadZonePx) return 0;

  const quantity = Math.min(
    maxQuantity,
    1 + Math.floor((Math.abs(distance) - deadZonePx) / pixelsPerQuantity),
  );
  return Math.sign(distance) * quantity;
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export function formatQuantity(value: number): string {
  return Math.abs(value - Math.round(value)) < 0.001
    ? String(Math.round(value))
    : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function parseDonationEntry(value: string, unit: 'lb' | 'each'): number {
  const digits = value.replace(/\D/g, '');
  if (!digits) return 0;
  const quantity = Number(digits);
  return unit === 'lb' ? quantity / 100 : quantity;
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function parseDuration(value: string): number | null {
  const match = value.trim().match(/^(\d+):([0-5]\d)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function formatDurationInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  if (!digits) return '';
  if (digits.length <= 2) return `0:${digits.padStart(2, '0')}`;
  const minutes = String(Number(digits.slice(0, -2)));
  return `${minutes}:${digits.slice(-2)}`;
}

export function eventDate(value: WasteEvent['eventAt']): Date {
  if (!value) return new Date();
  if (value instanceof Date) return value;
  return value.toDate();
}

export function eventCost(event: WasteEvent): number {
  return event.equivalentUnits * event.unitCostSnapshot;
}

export function productWaste(events: WasteEvent[], productId: string): { units: number; cost: number } {
  return events.reduce(
    (total, event) => {
      if (event.productId === productId) {
        total.units += event.equivalentUnits;
        total.cost += eventCost(event);
      }
      return total;
    },
    { units: 0, cost: 0 },
  );
}

export function daypartWaste(events: WasteEvent[], daypartId: DaypartId): { units: number; cost: number } {
  return events.reduce(
    (total, event) => {
      if (event.daypartId === daypartId) {
        total.units += event.equivalentUnits;
        total.cost += eventCost(event);
      }
      return total;
    },
    { units: 0, cost: 0 },
  );
}

export function displayProductQuantity(product: ProductConfig, equivalentUnits: number): string {
  if (product.trackingUnit === 'cup') return `${formatQuantity(equivalentUnits / (product.unitsPerCup || 14))} cups`;
  return formatQuantity(equivalentUnits);
}

export function mergeActivity(events: WasteEvent[], products: ProductConfig[]): MergedActivity[] {
  const productMap = new Map(products.map((product) => [product.id, product]));
  const groups = new Map<string, MergedActivity>();

  [...events]
    .sort((a, b) => eventDate(b.eventAt).getTime() - eventDate(a.eventAt).getTime())
    .forEach((event) => {
      const date = new Date(eventDate(event.eventAt));
      date.setSeconds(0, 0);
      const key = `${event.productId}-${date.getTime()}`;
      const current = groups.get(key);
      if (current) {
        current.equivalentUnits += event.equivalentUnits;
        current.displayQuantity += event.displayQuantity;
        current.cost += eventCost(event);
        current.sourceEventIds.push(event.id);
        if (!current.deviceNames.includes(event.deviceName)) current.deviceNames.push(event.deviceName);
        return;
      }
      const product = productMap.get(event.productId);
      groups.set(key, {
        key,
        productId: event.productId,
        productName: product?.name || event.productName,
        equivalentUnits: event.equivalentUnits,
        displayQuantity: event.displayQuantity,
        displayUnit: event.displayUnit,
        cost: eventCost(event),
        occurredAt: date,
        deviceNames: [event.deviceName],
        sourceEventIds: [event.id],
      });
    });

  return [...groups.values()].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}

export function donationPrediction(
  item: DonationItemConfig,
  settings: AppSettings,
  previousEvents: WasteEvent[],
  currentEvents: WasteEvent[],
): number | null {
  if (item.sourceProductIds.length === 0) return null;
  const eligibleEvents = [
    ...previousEvents.filter((event) => event.daypartId !== 'breakfast'),
    ...currentEvents.filter((event) => event.daypartId === 'breakfast'),
  ];
  const productMap = new Map(settings.products.map((product) => [product.id, product]));

  return item.sourceProductIds.reduce((total, productId) => {
    const units = eligibleEvents
      .filter((event) => event.productId === productId)
      .reduce((sum, event) => sum + event.equivalentUnits, 0);
    if (item.unit === 'each') return total + units;
    return total + units * (productMap.get(productId)?.averageWeightLb || 0);
  }, 0);
}

export const USAGE_RELIABLE_MINIMUM = 90;
export const USAGE_CAUTION_MINIMUM = 75;
export const USAGE_DONATION_TOLERANCE = 0.25;
export const USAGE_PRESENCE_START_DAY = '2026-08-15';
export const RELIABLE_USAGE_LABEL = 'Reliable data available';
export const INSUFFICIENT_USAGE_LABEL = 'Insufficient data for reliable insights';
export const AWAITING_DONATION_LABEL = 'Awaiting donation';

export type UsageScoreStatus = 'reliable' | 'provisional' | 'caution' | 'unreliable';

export interface DaypartUsageScore {
  daypartId: DaypartId;
  label: string;
  score: number;
  coverageScore: number | null;
  presenceMeasured: boolean;
  continuityScore: number;
  activeSlots: number;
  expectedSlots: number;
  eventCount: number;
  longestUnloggedHours: number;
  completed: boolean;
  confirmedZeroWaste: boolean;
  missedWaste: boolean;
  uncertainWaste: boolean;
  needsUsageReview: boolean;
  reasons: string[];
}

export interface UsageScoreResult {
  score: number;
  status: UsageScoreStatus;
  reportEligible: boolean;
  minimumRequired: number;
  coverageScore: number | null;
  presenceMeasured: boolean;
  continuityScore: number;
  donationScore: number | null;
  dayparts: DaypartUsageScore[];
  reasons: string[];
}

export function usagePresenceSlotKey(daypartId: DaypartId, startMinutes: number): string {
  return `${daypartId}_${String(startMinutes).padStart(4, '0')}`;
}

export function currentUsagePresenceSlot(
  dayparts: DaypartConfig[],
  date = new Date(),
): { daypartId: DaypartId; slotKey: string } | null {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const daypart = dayparts.find((candidate) => (
    minutes >= candidate.startMinutes && minutes < candidate.endMinutes
  ));
  if (!daypart) return null;
  const slotStart = daypart.startMinutes
    + Math.floor((minutes - daypart.startMinutes) / 15) * 15;
  return {
    daypartId: daypart.id,
    slotKey: usagePresenceSlotKey(daypart.id, slotStart),
  };
}

export function completedEmptyDaypartsNeedingReview({
  dayparts,
  events,
  usageRecord,
  selectedDayKey,
  now,
}: {
  dayparts: DaypartConfig[];
  events: WasteEvent[];
  usageRecord: UsageDayRecord | null;
  selectedDayKey: string;
  now: Date;
}): DaypartConfig[] {
  const currentDayKey = dayKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return dayparts.filter((daypart) => {
    const completed = selectedDayKey < currentDayKey
      || (selectedDayKey === currentDayKey && nowMinutes >= daypart.endMinutes);
    if (!completed) return false;
    const hasWaste = events.some((event) => (
      event.daypartId === daypart.id && event.equivalentUnits > 0
    ));
    const reviewed = usageRecord?.zeroWasteDaypartIds?.includes(daypart.id)
      || usageRecord?.missedWasteDaypartIds?.includes(daypart.id)
      || usageRecord?.uncertainWasteDaypartIds?.includes(daypart.id);
    return !hasWaste && !reviewed;
  });
}

function longestFalseRun(values: boolean[]): number {
  let longest = 0;
  let current = 0;
  values.forEach((value) => {
    current = value ? 0 : current + 1;
    longest = Math.max(longest, current);
  });
  return longest;
}

export function buildUsageScore({
  settings,
  selectedDayKey,
  now,
  currentWaste,
  previousWaste,
  donationCurrentWaste,
  donationPreviousWaste,
  donationRecord,
  usageRecord,
}: {
  settings: AppSettings;
  selectedDayKey: string;
  now: Date;
  currentWaste: WasteEvent[];
  previousWaste: WasteEvent[];
  donationCurrentWaste?: WasteEvent[];
  donationPreviousWaste?: WasteEvent[];
  donationRecord: DonationRecord | null;
  usageRecord: UsageDayRecord | null;
}): UsageScoreResult {
  const currentDayKey = dayKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const presenceMeasured = selectedDayKey >= USAGE_PRESENCE_START_DAY;
  const reconciliationCurrentWaste = donationCurrentWaste || currentWaste;
  const reconciliationPreviousWaste = donationPreviousWaste || previousWaste;
  const dayparts = settings.dayparts.flatMap<DaypartUsageScore>((daypart) => {
    const elapsedEnd = selectedDayKey < currentDayKey
      ? daypart.endMinutes
      : selectedDayKey > currentDayKey
        ? daypart.startMinutes
        : Math.min(daypart.endMinutes, Math.max(daypart.startMinutes, nowMinutes));
    if (elapsedEnd <= daypart.startMinutes) return [];

    const expectedSlotKeys: string[] = [];
    for (let cursor = daypart.startMinutes; cursor < elapsedEnd; cursor += 15) {
      expectedSlotKeys.push(usagePresenceSlotKey(daypart.id, cursor));
    }
    const activeSlots = presenceMeasured
      ? expectedSlotKeys.filter((slotKey) => usageRecord?.activeSlotKeys?.includes(slotKey)).length
      : 0;
    const coverageScore = presenceMeasured
      ? expectedSlotKeys.length ? activeSlots / expectedSlotKeys.length * 100 : 100
      : null;
    const daypartEvents = currentWaste.filter((event) => (
      event.daypartId === daypart.id && event.equivalentUnits > 0
    ));
    const completed = selectedDayKey < currentDayKey
      || (selectedDayKey === currentDayKey && nowMinutes >= daypart.endMinutes);
    const confirmedZeroWaste = Boolean(usageRecord?.zeroWasteDaypartIds?.includes(daypart.id));
    const missedWaste = Boolean(usageRecord?.missedWasteDaypartIds?.includes(daypart.id));
    const uncertainWaste = Boolean(usageRecord?.uncertainWasteDaypartIds?.includes(daypart.id));
    const hasRecordedOutcome = confirmedZeroWaste || missedWaste || uncertainWaste;
    const needsUsageReview = completed && daypartEvents.length === 0 && !hasRecordedOutcome;

    const completedHours: Array<{ start: number; end: number }> = [];
    for (let cursor = daypart.startMinutes; cursor < daypart.endMinutes; cursor += 60) {
      const end = Math.min(cursor + 60, daypart.endMinutes);
      if (end <= elapsedEnd) completedHours.push({ start: cursor, end });
    }
    const loggedHours = completedHours.map((hour) => daypartEvents.some((event) => {
      const occurredAt = eventDate(event.eventAt);
      const minutes = occurredAt.getHours() * 60 + occurredAt.getMinutes();
      return minutes >= hour.start && minutes < hour.end;
    }));
    const longestUnloggedHours = confirmedZeroWaste ? 0 : longestFalseRun(loggedHours);
    const continuityScore = confirmedZeroWaste
      ? 100
      : needsUsageReview || missedWaste || uncertainWaste
        ? 0
        : Math.max(0, 100 - Math.max(0, longestUnloggedHours - 2) * 25);
    const scoreWeight = presenceMeasured ? 70 : 25;
    const score = Math.round(((coverageScore || 0) * (presenceMeasured ? 45 : 0) + continuityScore * 25) / scoreWeight);
    const reasons: string[] = [];
    if (presenceMeasured && coverageScore !== null && coverageScore < USAGE_RELIABLE_MINIMUM) {
      reasons.push(`${activeSlots} of ${expectedSlotKeys.length} presence checks recorded`);
    }
    if (needsUsageReview) reasons.push('No Cool Down waste logged and the daypart has not been reviewed');
    else if (missedWaste) reasons.push('Team reported that waste occurred but was not logged');
    else if (uncertainWaste) reasons.push('Team could not confirm whether the empty daypart was accurate');
    else if (longestUnloggedHours > 2) reasons.push(`${longestUnloggedHours} consecutive hours without a Cool Down entry`);

    return [{
      daypartId: daypart.id,
      label: daypart.label,
      score,
      coverageScore: coverageScore === null ? null : Math.round(coverageScore),
      presenceMeasured,
      continuityScore: Math.round(continuityScore),
      activeSlots,
      expectedSlots: expectedSlotKeys.length,
      eventCount: daypartEvents.length,
      longestUnloggedHours,
      completed,
      confirmedZeroWaste,
      missedWaste,
      uncertainWaste,
      needsUsageReview,
      reasons,
    }];
  });

  const totalExpectedSlots = dayparts.reduce((sum, daypart) => sum + daypart.expectedSlots, 0);
  const totalActiveSlots = dayparts.reduce((sum, daypart) => sum + daypart.activeSlots, 0);
  const coverageScore = presenceMeasured
    ? totalExpectedSlots ? totalActiveSlots / totalExpectedSlots * 100 : 0
    : null;
  const continuityWeight = dayparts.reduce((sum, daypart) => sum + Math.max(1, Math.ceil(daypart.expectedSlots / 4)), 0);
  const continuityScore = continuityWeight
    ? dayparts.reduce((sum, daypart) => (
      sum + daypart.continuityScore * Math.max(1, Math.ceil(daypart.expectedSlots / 4))
    ), 0) / continuityWeight
    : 0;

  let donationScore: number | null = null;
  const donationReasons: string[] = [];
  if (donationRecord) {
    const comparableItems = settings.donationItems.filter((item) => item.sourceProductIds.length > 0);
    const itemScores = comparableItems.flatMap((item) => {
      const actual = Math.max(0, donationRecord.actuals[item.id] || 0);
      const tracked = Math.max(0, donationPrediction(
        item,
        settings,
        reconciliationPreviousWaste,
        reconciliationCurrentWaste,
      ) || 0);
      if (actual <= 0) return [];
      const fullCreditAt = actual * (1 - USAGE_DONATION_TOLERANCE);
      const itemScore = fullCreditAt <= 0 ? 100 : Math.min(100, tracked / fullCreditAt * 100);
      if (itemScore < 99.5) {
        donationReasons.push(`${item.name}: tracked ${formatQuantity(tracked)} vs donated ${formatQuantity(actual)}`);
      }
      return [itemScore];
    });
    donationScore = itemScores.length
      ? itemScores.reduce((sum, score) => sum + score, 0) / itemScores.length
      : 100;
  }

  const baseWeight = presenceMeasured ? 70 : 25;
  const baseWeighted = (coverageScore || 0) * (presenceMeasured ? 45 : 0) + continuityScore * 25;
  const scoreWeight = baseWeight + (donationScore === null ? 0 : 30);
  const score = Math.round((baseWeighted + (donationScore || 0) * (donationScore === null ? 0 : 30)) / scoreWeight);
  const hasCriticalGap = dayparts.some((daypart) => (
    daypart.needsUsageReview || daypart.missedWaste || daypart.uncertainWaste
  ));
  const donationPasses = donationScore !== null && donationScore >= 80;
  const reportEligible = score >= USAGE_RELIABLE_MINIMUM && !hasCriticalGap && donationPasses;
  const status: UsageScoreStatus = reportEligible
    ? 'reliable'
    : score >= USAGE_RELIABLE_MINIMUM && donationScore === null && !hasCriticalGap
      ? 'provisional'
      : score >= USAGE_CAUTION_MINIMUM
        ? 'caution'
        : 'unreliable';
  const reasons = [
    ...dayparts.flatMap((daypart) => daypart.reasons.map((reason) => `${daypart.label}: ${reason}`)),
    ...donationReasons,
  ];
  if (!donationRecord) reasons.push('Donation reconciliation is pending for this donation window');
  else if (donationScore !== null && donationScore < 80) reasons.push('Donation reconciliation is below the required 80%');
  if (reasons.length === 0) {
    reasons.push(presenceMeasured
      ? 'Presence, continuity, and donations all support reliable reporting'
      : 'Continuity and donations support reliable reporting; presence was not measured for this date');
  }

  return {
    score,
    status,
    reportEligible,
    minimumRequired: USAGE_RELIABLE_MINIMUM,
    coverageScore: coverageScore === null ? null : Math.round(coverageScore),
    presenceMeasured,
    continuityScore: Math.round(continuityScore),
    donationScore: donationScore === null ? null : Math.round(donationScore),
    dayparts,
    reasons,
  };
}

export interface DailyUsageReport {
  dayKey: string;
  donationDayKey: string;
  score: number | null;
  confidence: typeof RELIABLE_USAGE_LABEL | typeof INSUFFICIENT_USAGE_LABEL | typeof AWAITING_DONATION_LABEL;
  result: UsageScoreResult | null;
  reasons: string[];
}

export interface UsageRangeReport {
  score: number | null;
  confidence: DailyUsageReport['confidence'];
  reportEligible: boolean;
  scoredDays: number;
  pendingDays: number;
  totalDays: number;
  days: DailyUsageReport[];
}

export function buildUsageRangeReport({
  settings,
  startDayKey,
  endDayKey,
  now,
  wasteEvents,
  donationRecords,
  usageRecords,
}: {
  settings: AppSettings;
  startDayKey: string;
  endDayKey: string;
  now: Date;
  wasteEvents: WasteEvent[];
  donationRecords: DonationRecord[];
  usageRecords: UsageDayRecord[];
}): UsageRangeReport {
  const wasteByDay = new Map<string, WasteEvent[]>();
  wasteEvents.forEach((event) => {
    const dayEvents = wasteByDay.get(event.dayKey) || [];
    dayEvents.push(event);
    wasteByDay.set(event.dayKey, dayEvents);
  });
  const donationByDay = new Map(donationRecords.map((record) => [record.dayKey, record]));
  const usageByDay = new Map(usageRecords.map((record) => [record.dayKey, record]));

  const days = operatingDayKeysInRange(startDayKey, endDayKey).map<DailyUsageReport>((selectedDayKey) => {
    const donationDayKey = nextOperatingDayKey(selectedDayKey);
    const donationRecord = donationByDay.get(donationDayKey) || null;
    if (!donationRecord) {
      return {
        dayKey: selectedDayKey,
        donationDayKey,
        score: null,
        confidence: AWAITING_DONATION_LABEL,
        result: null,
        reasons: [`Awaiting the ${donationDayKey} donation submission`],
      };
    }

    const selectedDayWaste = wasteByDay.get(selectedDayKey) || [];
    const donationDayWaste = wasteByDay.get(donationDayKey) || [];
    const result = buildUsageScore({
      settings,
      selectedDayKey,
      now,
      currentWaste: selectedDayWaste,
      previousWaste: selectedDayWaste,
      donationPreviousWaste: selectedDayWaste,
      donationCurrentWaste: donationDayWaste,
      donationRecord,
      usageRecord: usageByDay.get(selectedDayKey) || null,
    });
    return {
      dayKey: selectedDayKey,
      donationDayKey,
      score: result.score,
      confidence: result.reportEligible ? RELIABLE_USAGE_LABEL : INSUFFICIENT_USAGE_LABEL,
      result,
      reasons: result.reasons,
    };
  });

  const finalizedDays = days.filter((day): day is DailyUsageReport & { score: number; result: UsageScoreResult } => (
    day.score !== null && day.result !== null
  ));
  const pendingDays = days.length - finalizedDays.length;
  const score = finalizedDays.length
    ? Math.round(finalizedDays.reduce((total, day) => total + day.score, 0) / finalizedDays.length)
    : null;
  const reportEligible = finalizedDays.length > 0
    && pendingDays === 0
    && finalizedDays.every((day) => day.result.reportEligible);
  const confidence = score === null
    ? AWAITING_DONATION_LABEL
    : reportEligible ? RELIABLE_USAGE_LABEL : INSUFFICIENT_USAGE_LABEL;

  return {
    score,
    confidence,
    reportEligible,
    scoredDays: finalizedDays.length,
    pendingDays,
    totalDays: days.length,
    days,
  };
}

export function targetDollarForProduct(product: ProductConfig, targetQuantity: number): number {
  const equivalentUnits = product.trackingUnit === 'cup'
    ? targetQuantity * (product.unitsPerCup || product.tapQuantity)
    : targetQuantity;
  return equivalentUnits * product.unitCost;
}

export function distributeDollarTarget(
  products: ProductConfig[],
  daypart: DaypartConfig,
  requestedTotal: number,
): Record<string, number> {
  const currentDollarTargets = products.map((product) => ({
    product,
    dollars: targetDollarForProduct(product, daypart.productTargetQuantities[product.id] || 0),
  }));
  const currentTotal = currentDollarTargets.reduce((sum, entry) => sum + entry.dollars, 0);
  const equalShare = products.length ? requestedTotal / products.length : 0;

  return Object.fromEntries(currentDollarTargets.map(({ product, dollars }) => {
    const allocatedDollars = currentTotal > 0 ? requestedTotal * (dollars / currentTotal) : equalShare;
    const costPerTargetUnit = product.unitCost * (product.trackingUnit === 'cup' ? (product.unitsPerCup || product.tapQuantity) : 1);
    return [product.id, costPerTargetUnit > 0 ? allocatedDollars / costPerTargetUnit : 0];
  }));
}

export type WasteExportGrouping = 'hour' | 'daypart';

export interface WasteTrendBucket {
  label: string;
  order: number;
  totalCost: number;
  averageCost: number;
  loggedDays: number;
  entries: number;
  products: Array<{
    name: string;
    quantity: number;
    averageQuantity: number;
    unit: 'each' | 'cups';
    totalCost: number;
    averageCost: number;
    loggedDays: number;
    entries: number;
  }>;
}

export interface DailyWasteCost {
  dayKey: string;
  totalCost: number;
  entries: number;
  highestContributingItem: string;
}

export function buildDailyWasteCosts(
  events: WasteEvent[],
  startDayKey: string,
  endDayKey: string,
): DailyWasteCost[] {
  const totals = new Map<string, {
    totalCost: number;
    entries: number;
    products: Map<string, { name: string; totalCost: number }>;
  }>();
  events.forEach((event) => {
    if (event.dayKey < startDayKey || event.dayKey > endDayKey || !isOperatingDayKey(event.dayKey)) return;
    const current = totals.get(event.dayKey) || { totalCost: 0, entries: 0, products: new Map() };
    const eventCost = event.equivalentUnits * event.unitCostSnapshot;
    current.totalCost += eventCost;
    current.entries += 1;
    const product = current.products.get(event.productId) || { name: event.productName, totalCost: 0 };
    product.totalCost += eventCost;
    current.products.set(event.productId, product);
    totals.set(event.dayKey, current);
  });

  const days: DailyWasteCost[] = [];
  const cursor = new Date(`${startDayKey}T12:00:00`);
  const end = new Date(`${endDayKey}T12:00:00`);
  while (cursor <= end) {
    const selectedDayKey = dayKey(cursor);
    if (cursor.getDay() !== 0) {
      const total = totals.get(selectedDayKey);
      const highestContributingItem = total
        ? [...total.products.values()]
          .filter((product) => product.totalCost > 0)
          .sort((a, b) => b.totalCost - a.totalCost || a.name.localeCompare(b.name))[0]?.name || ''
        : '';
      days.push({
        dayKey: selectedDayKey,
        totalCost: total?.totalCost || 0,
        entries: total?.entries || 0,
        highestContributingItem,
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export interface WeekdayWasteCost {
  weekday: number;
  dayLabel: string;
  dayKeys: string[];
  occurrenceCount: number;
  totalCost: number;
  averageCost: number;
  entries: number;
  highestContributingItem: string;
}

export function buildWeekdayWasteCosts(
  events: WasteEvent[],
  startDayKey: string,
  endDayKey: string,
): WeekdayWasteCost[] {
  const dailyCosts = buildDailyWasteCosts(events, startDayKey, endDayKey);
  const productTotals = new Map<number, Map<string, { name: string; totalCost: number }>>();
  events.forEach((event) => {
    if (event.dayKey < startDayKey || event.dayKey > endDayKey || !isOperatingDayKey(event.dayKey)) return;
    const weekday = dateFromDayKey(event.dayKey).getDay();
    const weekdayProducts = productTotals.get(weekday) || new Map();
    const product = weekdayProducts.get(event.productId) || { name: event.productName, totalCost: 0 };
    product.totalCost += event.equivalentUnits * event.unitCostSnapshot;
    weekdayProducts.set(event.productId, product);
    productTotals.set(weekday, weekdayProducts);
  });

  const dayLabels = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return Array.from({ length: 6 }, (_, index) => index + 1).flatMap((weekday) => {
    const days = dailyCosts.filter((day) => dateFromDayKey(day.dayKey).getDay() === weekday);
    if (days.length === 0) return [];
    const totalCost = days.reduce((sum, day) => sum + day.totalCost, 0);
    const highestContributingItem = [...(productTotals.get(weekday)?.values() || [])]
      .filter((product) => product.totalCost > 0)
      .sort((a, b) => b.totalCost - a.totalCost || a.name.localeCompare(b.name))[0]?.name || '';
    return [{
      weekday,
      dayLabel: dayLabels[weekday],
      dayKeys: days.map((day) => day.dayKey),
      occurrenceCount: days.length,
      totalCost,
      averageCost: totalCost / days.length,
      entries: days.reduce((sum, day) => sum + day.entries, 0),
      highestContributingItem,
    }];
  });
}

export interface DaypartTopWasteItem {
  daypartId: DaypartId;
  daypartLabel: string;
  productId: string | null;
  productName: string;
  totalCost: number;
}

type DaypartProductCost = { productId: string; productName: string; totalCost: number };

function daypartTopWasteItemsFromTotals(
  totals: Map<string, DaypartProductCost>,
  settings: AppSettings,
): DaypartTopWasteItem[] {
  return settings.dayparts.map((daypart) => {
    const highest = [...totals.entries()]
      .filter(([key, product]) => key.startsWith(`${daypart.id}|`) && product.totalCost > 0)
      .map(([, product]) => product)
      .sort((a, b) => b.totalCost - a.totalCost || a.productName.localeCompare(b.productName))[0];
    return {
      daypartId: daypart.id,
      daypartLabel: daypart.label,
      productId: highest?.productId || null,
      productName: highest?.productName || '',
      totalCost: highest?.totalCost || 0,
    };
  });
}

export function buildDaypartTopWasteItems(
  events: WasteEvent[],
  settings: AppSettings,
  startDayKey: string,
  endDayKey: string,
): DaypartTopWasteItem[] {
  const productNames = new Map(settings.products.map((product) => [product.id, product.name]));
  const totals = new Map<string, DaypartProductCost>();
  events.forEach((event) => {
    if (event.dayKey < startDayKey || event.dayKey > endDayKey || !isOperatingDayKey(event.dayKey)) return;
    const key = `${event.daypartId}|${event.productId}`;
    const current = totals.get(key) || {
      productId: event.productId,
      productName: productNames.get(event.productId) || event.productName,
      totalCost: 0,
    };
    current.totalCost += event.equivalentUnits * event.unitCostSnapshot;
    totals.set(key, current);
  });

  return daypartTopWasteItemsFromTotals(totals, settings);
}

export function buildDailyWasteSummary(
  events: WasteEvent[],
  storeId: string,
  selectedDayKey: string,
  computedBy: string,
): DailyWasteSummary {
  const totals = new Map<string, DailyWasteSummaryItem>();
  const sourceEvents = isOperatingDayKey(selectedDayKey)
    ? events.filter((event) => event.dayKey === selectedDayKey)
    : [];

  sourceEvents.forEach((event) => {
    const key = `${event.daypartId}|${event.productId}`;
    const current = totals.get(key) || {
      daypartId: event.daypartId,
      productId: event.productId,
      productName: event.productName,
      totalCost: 0,
    };
    current.totalCost += event.equivalentUnits * event.unitCostSnapshot;
    totals.set(key, current);
  });

  return {
    storeId,
    dayKey: selectedDayKey,
    items: [...totals.values()].sort((a, b) => (
      a.daypartId.localeCompare(b.daypartId) || a.productName.localeCompare(b.productName)
    )),
    sourceEventCount: sourceEvents.length,
    computedAt: null,
    computedBy,
  };
}

export function buildDaypartTopWasteItemsFromDailySummaries(
  summaries: DailyWasteSummary[],
  settings: AppSettings,
): DaypartTopWasteItem[] {
  const productNames = new Map(settings.products.map((product) => [product.id, product.name]));
  const totals = new Map<string, DaypartProductCost>();
  summaries.forEach((summary) => {
    if (!isOperatingDayKey(summary.dayKey)) return;
    summary.items.forEach((item) => {
      const key = `${item.daypartId}|${item.productId}`;
      const current = totals.get(key) || {
        productId: item.productId,
        productName: productNames.get(item.productId) || item.productName,
        totalCost: 0,
      };
      current.totalCost += item.totalCost;
      totals.set(key, current);
    });
  });
  return daypartTopWasteItemsFromTotals(totals, settings);
}

export interface DonationTopWasteItem {
  donationItemId: string;
  donationItemName: string;
  productId: string;
  tone: number;
  unit: DonationItemConfig['unit'];
  totalAmount: number;
  estimatedCost: number;
}

export function buildTopDonationWasteItems(
  records: DonationRecord[],
  settings: AppSettings,
  limit = 3,
): DonationTopWasteItem[] {
  const productMap = new Map(settings.products.map((product) => [product.id, product]));

  return settings.donationItems.flatMap((item) => {
    const products = item.sourceProductIds
      .map((productId) => productMap.get(productId))
      .filter((product): product is ProductConfig => Boolean(product));
    const costRates = products.map((product) => {
      if (item.unit === 'each') return product.unitCost;
      return product.averageWeightLb > 0 ? product.unitCost / product.averageWeightLb : 0;
    }).filter((costRate) => Number.isFinite(costRate) && costRate > 0);
    if (costRates.length === 0) return [];

    const totalAmount = records.reduce((total, record) => (
      isOperatingDayKey(record.dayKey)
        ? total + Math.max(0, record.actuals[item.id] || 0)
        : total
    ), 0);
    if (totalAmount <= 0) return [];

    const estimatedUnitCost = costRates.reduce((total, costRate) => total + costRate, 0) / costRates.length;
    return [{
      donationItemId: item.id,
      donationItemName: item.name,
      productId: products[0].id,
      tone: products[0].tone,
      unit: item.unit,
      totalAmount,
      estimatedCost: totalAmount * estimatedUnitCost,
    }];
  }).sort((a, b) => (
    b.estimatedCost - a.estimatedCost || a.donationItemName.localeCompare(b.donationItemName)
  )).slice(0, Math.max(0, limit));
}

export interface ProductCaseProjection {
  productId: string;
  totalCases: number | null;
  casesPerDay: number | null;
  casesPerWeek: number | null;
  casesPerMonth: number | null;
  operatingDays: number;
  operatingDaysInMonth: number;
}

export function buildProductCaseProjections(
  events: WasteEvent[],
  settings: AppSettings,
  startDayKey: string,
  endDayKey: string,
): ProductCaseProjection[] {
  const selectedOperatingDays = operatingDayCount(startDayKey, endDayKey);
  const end = dateFromDayKey(endDayKey);
  const monthStart = Number.isFinite(end.getTime())
    ? dayKey(new Date(end.getFullYear(), end.getMonth(), 1, 12))
    : '';
  const monthEnd = Number.isFinite(end.getTime())
    ? dayKey(new Date(end.getFullYear(), end.getMonth() + 1, 0, 12))
    : '';
  const operatingDaysInMonth = monthStart && monthEnd ? operatingDayCount(monthStart, monthEnd) : 0;
  const totals = new Map<string, number>();
  events.forEach((event) => {
    if (event.dayKey < startDayKey || event.dayKey > endDayKey || !isOperatingDayKey(event.dayKey)) return;
    totals.set(event.productId, (totals.get(event.productId) || 0) + event.equivalentUnits);
  });

  return settings.products.map((configuredProduct) => {
    const product = withDerivedProductPricing(configuredProduct);
    const caseWeightLb = product.caseWeightLb || 0;
    const canProject = selectedOperatingDays > 0
      && operatingDaysInMonth > 0
      && caseWeightLb > 0
      && product.averageWeightLb > 0;
    if (!canProject) {
      return {
        productId: product.id,
        totalCases: null,
        casesPerDay: null,
        casesPerWeek: null,
        casesPerMonth: null,
        operatingDays: selectedOperatingDays,
        operatingDaysInMonth,
      };
    }
    const totalUnits = Math.max(0, totals.get(product.id) || 0);
    const totalCases = totalUnits * product.averageWeightLb / caseWeightLb;
    const casesPerDay = totalCases / selectedOperatingDays;
    return {
      productId: product.id,
      totalCases,
      casesPerDay,
      casesPerWeek: casesPerDay * 6,
      casesPerMonth: casesPerDay * operatingDaysInMonth,
      operatingDays: selectedOperatingDays,
      operatingDaysInMonth,
    };
  });
}

export function buildWasteTrend(
  events: WasteEvent[],
  settings: AppSettings,
  grouping: WasteExportGrouping,
): WasteTrendBucket[] {
  const products = new Map(settings.products.map((product) => [product.id, product]));
  const dayparts = new Map(settings.dayparts.map((part, index) => [part.id, { label: part.label, order: index }]));
  const productRows = new Map<string, {
    bucket: string;
    bucketOrder: number;
    productName: string;
    quantity: number;
    unit: 'each' | 'cups';
    cost: number;
    entries: number;
    activeDays: Set<string>;
  }>();

  events.forEach((event) => {
    const product = products.get(event.productId);
    const date = eventDate(event.eventAt);
    const hour = date.getHours();
    const daypart = dayparts.get(event.daypartId);
    const bucket = grouping === 'hour'
      ? `${String(hour).padStart(2, '0')}:00-${String(hour).padStart(2, '0')}:59`
      : daypart?.label || event.daypartId;
    const bucketOrder = grouping === 'hour' ? hour : daypart?.order ?? 99;
    const key = `${bucketOrder}|${event.productId}`;
    const divisor = product?.trackingUnit === 'cup' ? (product.unitsPerCup || 14) : 1;
    const current = productRows.get(key) || {
      bucket,
      bucketOrder,
      productName: product?.name || event.productName,
      quantity: 0,
      unit: product?.trackingUnit === 'cup' ? 'cups' : 'each',
      cost: 0,
      entries: 0,
      activeDays: new Set<string>(),
    };
    current.quantity += event.equivalentUnits / divisor;
    current.cost += event.equivalentUnits * event.unitCostSnapshot;
    current.entries += 1;
    current.activeDays.add(event.dayKey);
    productRows.set(key, current);
  });

  const buckets = new Map<number, {
    label: string;
    order: number;
    totalCost: number;
    entries: number;
    activeDays: Set<string>;
  }>();
  events.forEach((event) => {
    const date = eventDate(event.eventAt);
    const hour = date.getHours();
    const daypart = dayparts.get(event.daypartId);
    const order = grouping === 'hour' ? hour : daypart?.order ?? 99;
    const current = buckets.get(order) || {
      label: grouping === 'hour'
        ? `${String(hour).padStart(2, '0')}:00-${String(hour).padStart(2, '0')}:59`
        : daypart?.label || event.daypartId,
      order,
      totalCost: 0,
      entries: 0,
      activeDays: new Set<string>(),
    };
    current.totalCost += event.equivalentUnits * event.unitCostSnapshot;
    current.entries += 1;
    current.activeDays.add(event.dayKey);
    buckets.set(order, current);
  });

  return [...buckets.values()].map((bucket) => ({
    label: bucket.label,
    order: bucket.order,
    totalCost: bucket.totalCost,
    averageCost: bucket.totalCost / Math.max(1, bucket.activeDays.size),
    loggedDays: bucket.activeDays.size,
    entries: bucket.entries,
    products: [...productRows.values()]
      .filter((row) => row.bucketOrder === bucket.order)
      .map((row) => ({
        name: row.productName,
        quantity: row.quantity,
        averageQuantity: row.quantity / Math.max(1, row.activeDays.size),
        unit: row.unit,
        totalCost: row.cost,
        averageCost: row.cost / Math.max(1, row.activeDays.size),
        loggedDays: row.activeDays.size,
        entries: row.entries,
      }))
      .sort((a, b) => b.averageCost - a.averageCost),
  })).sort((a, b) => b.averageCost - a.averageCost);
}

export function buildWasteCsv(
  events: WasteEvent[],
  settings: AppSettings,
  grouping: WasteExportGrouping,
  startDayKey: string,
  endDayKey = startDayKey,
  daysInRange = 1,
): string {
  const trend = buildWasteTrend(events, settings, grouping);
  const productTimeRanks = new Map<string, number>();
  const productAppearances = new Map<string, Array<{ bucket: string; averageCost: number }>>();
  trend.forEach((bucket) => bucket.products.forEach((product) => {
    const appearances = productAppearances.get(product.name) || [];
    appearances.push({ bucket: bucket.label, averageCost: product.averageCost });
    productAppearances.set(product.name, appearances);
  }));
  productAppearances.forEach((appearances, productName) => {
    appearances
      .sort((a, b) => b.averageCost - a.averageCost)
      .forEach((appearance, index) => {
        productTimeRanks.set(`${productName}|${appearance.bucket}`, index + 1);
      });
  });
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [[
    'Overall time rank',
    'Range start',
    'Range end',
    grouping === 'hour' ? 'Hour' : 'Daypart',
    'Row type',
    'Product',
    grouping === 'hour' ? 'Hour rank for this product' : 'Daypart rank for this product',
    grouping === 'hour' ? 'Product rank within this hour' : 'Product rank within this daypart',
    grouping === 'hour' ? 'Top 3 hour for this product?' : 'Top 3 daypart for this product?',
    grouping === 'hour' ? 'Top 3 product for this hour?' : 'Top 3 product for this daypart?',
    'Filter instructions',
    'Average cool down dollars per logged day',
    'Total cool down dollars',
    'Average quantity per logged day',
    'Total net quantity',
    'Unit',
    'Logged days',
    'Days in range',
    'Entries',
  ]];
  trend.forEach((bucket, index) => {
    lines.push([
      String(index + 1),
      startDayKey,
      endDayKey,
      bucket.label,
      'All products summary',
      'All products',
      '',
      '',
      '',
      '',
      'Use Product detail rows. Filter a Product plus its Top 3 time column = YES, or filter an Hour/Daypart plus its Top 3 product column = YES.',
      bucket.averageCost.toFixed(2),
      bucket.totalCost.toFixed(2),
      '',
      '',
      '',
      String(bucket.loggedDays),
      String(daysInRange),
      String(bucket.entries),
    ]);
    bucket.products.forEach((product, productIndex) => {
      const timeRank = productTimeRanks.get(`${product.name}|${bucket.label}`) || 0;
      const productRank = productIndex + 1;
      lines.push([
        String(index + 1),
        startDayKey,
        endDayKey,
        bucket.label,
        'Product detail',
        product.name,
        String(timeRank || ''),
        String(productRank),
        timeRank <= 3 ? 'YES' : '',
        productRank <= 3 ? 'YES' : '',
        'Filter Product and Top 3 time = YES; or filter Hour/Daypart and Top 3 product = YES.',
        product.averageCost.toFixed(2),
        product.totalCost.toFixed(2),
        formatQuantity(product.averageQuantity),
        formatQuantity(product.quantity),
        product.unit,
        String(product.loggedDays),
        String(daysInRange),
        String(product.entries),
      ]);
    });
  });
  return lines.map((line) => line.map(escape).join(',')).join('\r\n');
}

export function buildDonationCsv(
  records: DonationRecord[],
  settings: AppSettings,
  startDayKey: string,
  endDayKey = startDayKey,
  _daysInRange = 1,
): string {
  const configuredRows = settings.donationItems.map((item) => {
    const submitted = records.filter((record) => Object.hasOwn(record.actuals, item.id));
    const actualTotal = submitted.reduce((sum, record) => sum + (record.actuals[item.id] || 0), 0);
    return {
      name: item.name,
      unit: submitted[0]?.units[item.id] || item.unit,
      actualTotal,
    };
  });
  const legacyItems = [
    { id: 'grilled-total', name: 'Legacy Grilled Total', unit: 'lb' as const },
    { id: 'spicy-total', name: 'Legacy Spicy Total', unit: 'lb' as const },
    { id: 'filet-total', name: 'Legacy Filet Total', unit: 'lb' as const },
  ];
  const legacyRows = legacyItems
    .filter((item) => records.some((record) => Object.hasOwn(record.actuals, item.id)))
    .map((item) => ({
      name: item.name,
      unit: item.unit,
      actualTotal: records.reduce((sum, record) => sum + (record.actuals[item.id] || 0), 0),
    }));
  const rows = [...configuredRows, ...legacyRows];
  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [[
    'Range start',
    'Range end',
    'Donation item',
    'Unit',
    'Total actual',
  ]];
  rows.forEach((row) => lines.push([
    startDayKey,
    endDayKey,
    row.name,
    row.unit,
    formatQuantity(row.actualTotal),
  ]));
  return lines.map((line) => line.map(escape).join(',')).join('\r\n');
}
