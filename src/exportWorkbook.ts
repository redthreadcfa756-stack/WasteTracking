import ExcelJS from 'exceljs';
import type { AppSettings, DonationRecord, WasteEvent } from './types';
import {
  buildDaypartTopWasteItems,
  buildDailyWasteCosts,
  buildProductCaseProjections,
  type WasteExportGrouping,
  type WasteTrendBucket,
} from './domain';

const RED = 'FFBA002E';
const DARK = 'FF111D23';
const PALE_BLUE = 'FFF4FAFF';
const YELLOW = 'FFFFEB3B';
const WHITE = 'FFFFFFFF';

function applyTitle(sheet: ExcelJS.Worksheet, lastColumn: number, title: string) {
  sheet.mergeCells(1, 1, 1, lastColumn);
  const cell = sheet.getCell(1, 1);
  cell.value = title;
  cell.font = { bold: true, color: { argb: WHITE }, size: 16 };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
  cell.alignment = { vertical: 'middle', horizontal: 'left' };
  sheet.getRow(1).height = 30;
}

function applyHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: WHITE } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DARK } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 30;
}

function timeLabels(settings: AppSettings, grouping: WasteExportGrouping): string[] {
  if (grouping === 'daypart') return settings.dayparts.map((part) => part.label);
  return Array.from({ length: 16 }, (_, index) => {
    const hour = index + 6;
    return `${String(hour).padStart(2, '0')}:00-${String(hour).padStart(2, '0')}:59`;
  });
}

const DONATION_EXPORT_ORDER = [
  'Full Strip Bacon',
  'Biscuits',
  'Spicy filet',
  'Spicy Breakfast',
  'Filet',
  'Breakfast Filet',
  'Grilled Filet',
  'Grilled Nuggets',
  'Grilled Breakfast',
  'Nuggets',
  'Strips',
  'Yellow Total',
  'English Muffins',
  'Hashbrown',
  'Mini Rolls',
  'Sausage',
  'Tortillas',
  'Mac & Cheese',
  'Noodle Soup',
  'Tortilla Soup',
];

export async function createDonationWorkbook({
  records,
  settings,
  startDayKey,
  endDayKey,
}: {
  records: DonationRecord[];
  settings: AppSettings;
  startDayKey: string;
  endDayKey: string;
  source: 'live' | 'demo';
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CoolDownTracker';
  workbook.created = new Date();
  workbook.subject = 'Donation totals report';

  const order = new Map(DONATION_EXPORT_ORDER.map((name, index) => [name.toLowerCase(), index]));
  const items = [...settings.donationItems].sort((a, b) => {
    const aOrder = order.get(a.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = order.get(b.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder || a.name.localeCompare(b.name);
  });
  const totals = new Map(items.map((item) => [
    item.id,
    records.reduce((sum, record) => sum + (record.actuals[item.id] || 0), 0),
  ]));
  const displayUnit = (itemId: string, fallback: string) => {
    const submittedUnit = records.find((record) => record.units[itemId])?.units[itemId] || fallback;
    if (submittedUnit === 'lb') return 'lbs';
    if (submittedUnit === 'oz') return 'oz';
    return 'each';
  };

  const sheet = workbook.addWorksheet('Donation Totals', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: false }],
  });
  sheet.getCell('A1').value = 'Date Range';
  sheet.getCell('A1').font = { bold: true, size: 12 };
  sheet.getRow(2).values = ['Start', 'End'];
  sheet.getRow(2).font = { bold: true };
  sheet.getCell('A3').value = new Date(`${startDayKey}T12:00:00`);
  sheet.getCell('B3').value = new Date(`${endDayKey}T12:00:00`);
  sheet.getCell('A3').numFmt = 'm-d-yy';
  sheet.getCell('B3').numFmt = 'm-d-yy';
  sheet.getRow(5).values = ['Item', 'Unit', 'Total Donated for Range'];
  applyHeader(sheet.getRow(5));

  items.forEach((item, index) => {
    const rowNumber = index + 6;
    const preferredNameIndex = order.get(item.name.toLowerCase());
    sheet.getCell(rowNumber, 1).value = preferredNameIndex === undefined
      ? item.name
      : DONATION_EXPORT_ORDER[preferredNameIndex];
    sheet.getCell(rowNumber, 2).value = displayUnit(item.id, item.unit);
    sheet.getCell(rowNumber, 3).value = totals.get(item.id) || 0;
    sheet.getCell(rowNumber, 3).numFmt = '0.##';
    if (index % 2 === 1) {
      sheet.getRow(rowNumber).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
    }
  });

  const lastRow = items.length + 5;
  sheet.autoFilter = { from: 'A5', to: `C${lastRow}` };
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 12;
  sheet.getColumn(3).width = 25;
  sheet.getColumn(3).alignment = { horizontal: 'right' };

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as unknown as ArrayBuffer;
}

export async function createWasteTrendWorkbook({
  events,
  trend,
  settings,
  grouping,
  startDayKey,
  endDayKey,
  source,
  metric,
}: {
  events: WasteEvent[];
  trend: WasteTrendBucket[];
  settings: AppSettings;
  grouping: WasteExportGrouping;
  startDayKey: string;
  endDayKey: string;
  source: 'live' | 'demo';
  metric: 'cost' | 'quantity';
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CoolDownTracker';
  workbook.created = new Date();
  workbook.subject = 'Cool Down trend report';

  const dailyCosts = buildDailyWasteCosts(events, startDayKey, endDayKey);
  const daypartTopWaste = buildDaypartTopWasteItems(events, settings, startDayKey, endDayKey);
  const topCostRanks = new Map(
    [...dailyCosts]
      .filter((day) => day.totalCost > 0)
      .sort((a, b) => b.totalCost - a.totalCost || a.dayKey.localeCompare(b.dayKey))
      .slice(0, 3)
      .map((day, index) => [day.dayKey, index + 1]),
  );
  const daily = workbook.addWorksheet('Daily Waste Cost', {
    views: [{ state: 'frozen', ySplit: 4, showGridLines: false }],
  });
  applyTitle(daily, 4, 'Daily Waste Cost');
  daily.getCell('A2').value = 'Date range';
  daily.getCell('B2').value = startDayKey;
  daily.getCell('C2').value = endDayKey;
  daily.getCell('A3').value = 'How to read';
  daily.getCell('B3').value = 'Monday–Saturday totals are ranked by cool down cost. The three highest-cost days are highlighted yellow. Highest contributing items use net product cost for the day or selected-period daypart.';
  daily.mergeCells('B3:D3');
  daily.getCell('B3').alignment = { wrapText: true, vertical: 'middle' };
  daily.getRow(3).height = 30;
  daily.getRow(4).values = ['Day', 'Date', 'Total Cost', 'Highest Contributing Item'];
  applyHeader(daily.getRow(4));

  dailyCosts.forEach((day, index) => {
    const rowNumber = index + 5;
    const row = daily.getRow(rowNumber);
    const rank = topCostRanks.get(day.dayKey);
    const date = new Date(`${day.dayKey}T12:00:00`);
    daily.getCell(rowNumber, 1).value = date.toLocaleDateString('en-US', { weekday: 'long' });
    daily.getCell(rowNumber, 2).value = date;
    daily.getCell(rowNumber, 2).numFmt = 'm-d-yy';
    daily.getCell(rowNumber, 3).value = day.totalCost;
    daily.getCell(rowNumber, 3).numFmt = '$0.00';
    daily.getCell(rowNumber, 4).value = day.highestContributingItem || '—';
    if (index % 2 === 1) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
    }
    if (rank) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      row.font = { bold: true, color: { argb: DARK } };
    }
  });
  const lastDailyRow = Math.max(4, dailyCosts.length + 4);
  daily.autoFilter = { from: 'A4', to: `D${lastDailyRow}` };
  const daypartTitleRow = lastDailyRow + 2;
  const daypartHeaderRow = daypartTitleRow + 1;
  daily.mergeCells(daypartTitleRow, 1, daypartTitleRow, 4);
  const daypartTitle = daily.getCell(daypartTitleRow, 1);
  daypartTitle.value = 'Top Wasted Item by Daypart — Selected Period';
  daypartTitle.font = { bold: true, color: { argb: WHITE }, size: 12 };
  daypartTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
  daypartTitle.alignment = { vertical: 'middle', horizontal: 'left' };
  daily.getRow(daypartTitleRow).height = 24;
  daily.getRow(daypartHeaderRow).values = ['Daypart', 'Top Wasted Item', 'Contributing Cost'];
  applyHeader(daily.getRow(daypartHeaderRow));
  daypartTopWaste.forEach((daypart, index) => {
    const rowNumber = daypartHeaderRow + index + 1;
    const row = daily.getRow(rowNumber);
    daily.getCell(rowNumber, 1).value = daypart.daypartLabel;
    daily.getCell(rowNumber, 1).font = { bold: true };
    daily.getCell(rowNumber, 2).value = daypart.productName || '—';
    daily.getCell(rowNumber, 3).value = daypart.totalCost;
    daily.getCell(rowNumber, 3).numFmt = '$0.00';
    if (index % 2 === 1) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
    }
  });
  daily.getColumn(1).width = 16;
  daily.getColumn(2).width = 24;
  daily.getColumn(3).width = 18;
  daily.getColumn(4).width = 28;

  const productCaseProjections = new Map(
    buildProductCaseProjections(events, settings, startDayKey, endDayKey)
      .map((projection) => [projection.productId, projection]),
  );
  const productNames = settings.products.map((product) => product.name);
  const labels = timeLabels(settings, grouping);
  const trendByLabel = new Map(trend.map((bucket) => [bucket.label, bucket]));
  const matrix = workbook.addWorksheet('Product by Time', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 5, showGridLines: false }],
  });
  const lastColumn = Math.max(2, productNames.length + 1);

  applyTitle(matrix, lastColumn, 'Cool Down Matrix');
  matrix.getCell('A2').value = 'Date range';
  matrix.getCell('B2').value = startDayKey;
  matrix.getCell('C2').value = endDayKey;
  matrix.getCell('A3').value = 'Data source';
  matrix.getCell('B3').value = source === 'demo' ? 'Demo data' : 'Live data';
  matrix.getCell('A4').value = 'How to read';
  matrix.getCell('B4').value = metric === 'cost'
    ? 'Each value is average cool down dollars per logged day. The top three dollar cool down times for each product are highlighted yellow. Case projections use total net quantity divided by every selected Monday–Saturday day; weekly is daily × 6 and monthly uses the exact Monday–Saturday count in the ending date’s month.'
    : 'Each value is average cool down units per logged day. The top three unit cool down times for each product are highlighted yellow. Case projections use total net quantity divided by every selected Monday–Saturday day; weekly is daily × 6 and monthly uses the exact Monday–Saturday count in the ending date’s month.';
  matrix.mergeCells(4, 2, 4, lastColumn);
  matrix.getCell('A5').value = grouping === 'hour' ? 'Hour' : 'Daypart';
  productNames.forEach((name, index) => {
    const config = settings.products.find((product) => product.name === name);
    const unitLabel = config?.trackingUnit === 'cup' ? 'cups' : 'each';
    matrix.getCell(5, index + 2).value = metric === 'quantity' ? `${name} (${unitLabel})` : name;
  });
  applyHeader(matrix.getRow(5));

  labels.forEach((label, rowIndex) => {
    const rowNumber = rowIndex + 6;
    matrix.getCell(rowNumber, 1).value = label;
    matrix.getCell(rowNumber, 1).font = { bold: true };
    if (rowIndex % 2 === 1) {
      matrix.getRow(rowNumber).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
    }
    const bucket = trendByLabel.get(label);
    productNames.forEach((name, productIndex) => {
      const product = bucket?.products.find((candidate) => candidate.name === name);
      const cell = matrix.getCell(rowNumber, productIndex + 2);
      cell.value = product ? (metric === 'cost' ? product.averageCost : product.averageQuantity) : null;
      cell.numFmt = metric === 'cost' ? '$0.00' : '0.00';
      cell.alignment = { horizontal: 'center' };
    });
  });

  productNames.forEach((name, productIndex) => {
    const ranked = trend
      .map((bucket) => {
        const product = bucket.products.find((candidate) => candidate.name === name);
        return {
          label: bucket.label,
          value: product ? (metric === 'cost' ? product.averageCost : product.averageQuantity) : 0,
        };
      })
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);
    ranked.forEach((entry) => {
      const rowIndex = labels.indexOf(entry.label);
      if (rowIndex < 0) return;
      const cell = matrix.getCell(rowIndex + 6, productIndex + 2);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
      cell.font = { bold: true, color: { argb: DARK } };
    });
  });

  const firstProjectionRow = 5 + labels.length + 2;
  const projectionRows = [
    { label: 'Projected cases / operating day', key: 'casesPerDay' as const },
    { label: 'Projected cases / business week', key: 'casesPerWeek' as const },
    { label: 'Projected cases / calendar month', key: 'casesPerMonth' as const },
  ];
  projectionRows.forEach((projectionRow, index) => {
    const rowNumber = firstProjectionRow + index;
    const row = matrix.getRow(rowNumber);
    matrix.getCell(rowNumber, 1).value = projectionRow.label;
    matrix.getCell(rowNumber, 1).font = { bold: true, color: { argb: DARK } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
    row.height = 24;
    settings.products.forEach((product, productIndex) => {
      const projection = productCaseProjections.get(product.id);
      const value = projection?.[projectionRow.key];
      const cell = matrix.getCell(rowNumber, productIndex + 2);
      cell.value = value === null || value === undefined ? 'Not configured' : value;
      if (typeof cell.value === 'number') cell.numFmt = '0.000 "cases"';
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
  });
  matrix.getRow(firstProjectionRow).border = {
    top: { style: 'medium', color: { argb: DARK } },
  };

  matrix.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: 5 + labels.length, column: lastColumn },
  };
  matrix.getColumn(1).width = 34;
  for (let column = 2; column <= lastColumn; column += 1) matrix.getColumn(column).width = 18;
  matrix.getRow(4).height = 58;
  matrix.getCell('B4').alignment = { wrapText: true, vertical: 'middle' };

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as unknown as ArrayBuffer;
}
