import type {
  AppSettings,
  DaypartConfig,
  DaypartId,
  DonationItemConfig,
  DonationRecord,
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

export type WasteExportGrouping = 'hour' | 'daypart';

export function buildWasteCsv(
  events: WasteEvent[],
  settings: AppSettings,
  grouping: WasteExportGrouping,
  startDayKey: string,
  endDayKey = startDayKey,
  daysInRange = 1,
): string {
  const products = new Map(settings.products.map((product) => [product.id, product]));
  const dayparts = new Map(settings.dayparts.map((part, index) => [part.id, { label: part.label, order: index }]));
  const rows = new Map<string, {
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
    const current = rows.get(key) || {
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
    rows.set(key, current);
  });

  const escape = (value: string | number) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [[
    'Range start',
    'Range end',
    grouping === 'hour' ? 'Hour' : 'Daypart',
    'Product',
    'Total net quantity',
    'Average quantity per logged day',
    'Unit',
    'Total waste dollars',
    'Average waste dollars per logged day',
    'Days with entries',
    'Days in range',
    'Entries',
  ]];
  [...rows.values()]
    .sort((a, b) => a.bucketOrder - b.bucketOrder || a.productName.localeCompare(b.productName))
    .forEach((row) => {
      const loggedDays = Math.max(1, row.activeDays.size);
      lines.push([
        startDayKey,
        endDayKey,
        row.bucket,
        row.productName,
        formatQuantity(row.quantity),
        formatQuantity(row.quantity / loggedDays),
        row.unit,
        row.cost.toFixed(2),
        (row.cost / loggedDays).toFixed(2),
        String(row.activeDays.size),
        String(daysInRange),
        String(row.entries),
      ]);
    });
  return lines.map((line) => line.map(escape).join(',')).join('\r\n');
}

export function buildDonationCsv(
  records: DonationRecord[],
  settings: AppSettings,
  startDayKey: string,
  endDayKey = startDayKey,
  daysInRange = 1,
): string {
  const rows = settings.donationItems.map((item) => {
    const submitted = records.filter((record) => Object.hasOwn(record.actuals, item.id));
    const predicted = submitted.filter((record) => record.predictions[item.id] !== null && record.predictions[item.id] !== undefined);
    const actualTotal = submitted.reduce((sum, record) => sum + (record.actuals[item.id] || 0), 0);
    const predictedTotal = predicted.reduce((sum, record) => sum + (record.predictions[item.id] || 0), 0);
    const variances = submitted.filter((record) => record.variance[item.id] !== null && record.variance[item.id] !== undefined);
    const varianceTotal = variances.reduce((sum, record) => sum + (record.variance[item.id] || 0), 0);
    return {
      name: item.name,
      unit: submitted[0]?.units[item.id] || item.unit,
      actualTotal,
      actualAverage: submitted.length ? actualTotal / submitted.length : 0,
      predictedTotal,
      predictedAverage: predicted.length ? predictedTotal / predicted.length : null,
      varianceTotal,
      varianceAverage: variances.length ? varianceTotal / variances.length : null,
      submittedDays: submitted.length,
      predictionDays: predicted.length,
      initials: [...new Set(submitted.map((record) => record.initials))].join(' | '),
      maxRevision: submitted.reduce((highest, record) => Math.max(highest, record.revision), 0),
    };
  });
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
    'Average actual per submitted day',
    'Total predicted',
    'Average predicted per predicted day',
    'Total variance',
    'Average variance',
    'Submitted days',
    'Prediction days',
    'Days in range',
    'Initials',
    'Highest revision',
  ]];
  rows.forEach((row) => lines.push([
    startDayKey,
    endDayKey,
    row.name,
    row.unit,
    formatQuantity(row.actualTotal),
    formatQuantity(row.actualAverage),
    row.predictionDays ? formatQuantity(row.predictedTotal) : '',
    row.predictedAverage === null ? '' : formatQuantity(row.predictedAverage),
    row.varianceAverage === null ? '' : formatQuantity(row.varianceTotal),
    row.varianceAverage === null ? '' : formatQuantity(row.varianceAverage),
    String(row.submittedDays),
    String(row.predictionDays),
    String(daysInRange),
    row.initials,
    String(row.maxRevision),
  ]));
  return lines.map((line) => line.map(escape).join(',')).join('\r\n');
}
