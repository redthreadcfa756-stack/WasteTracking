import ExcelJS from 'exceljs';
import type { AppSettings, DonationRecord } from './types';
import type { WasteExportGrouping, WasteTrendBucket } from './domain';

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
  workbook.creator = 'WasteTracker';
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
  trend,
  settings,
  grouping,
  startDayKey,
  endDayKey,
  source,
  metric,
}: {
  trend: WasteTrendBucket[];
  settings: AppSettings;
  grouping: WasteExportGrouping;
  startDayKey: string;
  endDayKey: string;
  source: 'live' | 'demo';
  metric: 'cost' | 'quantity';
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WasteTracker';
  workbook.created = new Date();
  workbook.subject = 'Waste opportunity trend report';

  const productNames = settings.products.map((product) => product.name);
  const labels = timeLabels(settings, grouping);
  const trendByLabel = new Map(trend.map((bucket) => [bucket.label, bucket]));
  const matrix = workbook.addWorksheet('Product by Time', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 5, showGridLines: false }],
  });
  const lastColumn = Math.max(2, productNames.length + 1);

  applyTitle(matrix, lastColumn, 'Waste Opportunity Matrix');
  matrix.getCell('A2').value = 'Date range';
  matrix.getCell('B2').value = startDayKey;
  matrix.getCell('C2').value = endDayKey;
  matrix.getCell('A3').value = 'Data source';
  matrix.getCell('B3').value = source === 'demo' ? 'Demo data' : 'Live data';
  matrix.getCell('A4').value = 'How to read';
  matrix.getCell('B4').value = metric === 'cost'
    ? 'Each value is average waste dollars per logged day. The top three dollar-waste times for each product are highlighted yellow.'
    : 'Each value is average units wasted per logged day. The top three unit-waste times for each product are highlighted yellow.';
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

  matrix.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: 5 + labels.length, column: lastColumn },
  };
  matrix.getColumn(1).width = 18;
  for (let column = 2; column <= lastColumn; column += 1) matrix.getColumn(column).width = 16;
  matrix.getRow(4).height = 32;
  matrix.getCell('B4').alignment = { wrapText: true, vertical: 'middle' };

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as unknown as ArrayBuffer;
}
