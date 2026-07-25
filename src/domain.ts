import type {
  AppSettings,
  DaypartConfig,
  DaypartId,
  DonationItemConfig,
  MergedActivity,
  ProductConfig,
  WasteEvent,
} from './types';

export function dayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function previousDayKey(date = new Date()): string {
  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return dayKey(previous);
}

export function detectDaypart(dayparts: DaypartConfig[], date = new Date()): DaypartId {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const matching = dayparts.find((part) => minutes >= part.startMinutes && minutes < part.endMinutes);
  if (matching) return matching.id;
  if (minutes < dayparts[0].startMinutes) return 'breakfast';
  return 'late-dinner';
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export function formatQuantity(value: number): string {
  return Math.abs(value - Math.round(value)) < 0.001
    ? String(Math.round(value))
    : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
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
