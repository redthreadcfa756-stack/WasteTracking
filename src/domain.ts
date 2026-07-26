import type {
  AppSettings,
  CooldownTimer,
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
    'Average waste dollars per logged day',
    'Total waste dollars',
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
