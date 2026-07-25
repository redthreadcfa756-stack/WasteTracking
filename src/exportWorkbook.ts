import ExcelJS from 'exceljs';
import type { AppSettings, DonationRecord } from './types';
import type { WasteExportGrouping, WasteTrendBucket } from './domain';

const RED = 'FFBA002E';
const DARK = 'FF111D23';
const PALE_BLUE = 'FFF4FAFF';
const LIGHT_BLUE = 'FFDCEAF1';
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
  'Breakfast filet',
  'Grilled filet',
  'Grilled nuggets',
  'Grilled breakfast',
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
  source,
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
  sheet.getCell('A5').value = 'Item';
  sheet.getCell('B5').value = 'Total Donated for Range';
  applyHeader(sheet.getRow(5));

  items.forEach((item, index) => {
    const rowNumber = index + 6;
    const preferredNameIndex = order.get(item.name.toLowerCase());
    sheet.getCell(rowNumber, 1).value = preferredNameIndex === undefined
      ? item.name
      : DONATION_EXPORT_ORDER[preferredNameIndex];
    sheet.getCell(rowNumber, 2).value = totals.get(item.id) || 0;
    sheet.getCell(rowNumber, 2).numFmt = '0.##';
    if (index % 2 === 1) {
      sheet.getRow(rowNumber).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
    }
  });

  const lastRow = items.length + 5;
  sheet.autoFilter = { from: 'A5', to: `B${lastRow}` };
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 25;
  sheet.getColumn(2).alignment = { horizontal: 'right' };
  sheet.getCell('A2').alignment = { horizontal: 'left' };
  sheet.getCell('B2').alignment = { horizontal: 'left' };

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
}: {
  trend: WasteTrendBucket[];
  settings: AppSettings;
  grouping: WasteExportGrouping;
  startDayKey: string;
  endDayKey: string;
  source: 'live' | 'demo';
}): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WasteTracker';
  workbook.created = new Date();
  workbook.subject = 'Waste opportunity trend report';

  const productNames = settings.products
    .map((product) => product.name)
    .filter((name) => trend.some((bucket) => bucket.products.some((product) => product.name === name)));
  const labels = timeLabels(settings, grouping);
  const trendByLabel = new Map(trend.map((bucket) => [bucket.label, bucket]));

  const matrix = workbook.addWorksheet('Product by Time', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 5, showGridLines: false }],
  });
  const lastMatrixColumn = Math.max(2, productNames.length + 1);
  applyTitle(matrix, lastMatrixColumn, 'Waste Opportunity Matrix');
  matrix.getCell('A2').value = 'Date range';
  matrix.getCell('B2').value = startDayKey;
  matrix.getCell('C2').value = endDayKey;
  matrix.getCell('A3').value = 'Data source';
  matrix.getCell('B3').value = source === 'demo' ? 'Demo data' : 'Live data';
  matrix.getCell('A4').value = 'How to read';
  matrix.getCell('B4').value = 'Each value is average waste dollars per logged day. The top three times for each product are highlighted yellow.';
  matrix.mergeCells(4, 2, 4, lastMatrixColumn);
  matrix.getCell('A5').value = grouping === 'hour' ? 'Hour' : 'Daypart';
  productNames.forEach((name, index) => {
    matrix.getCell(5, index + 2).value = name;
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
      cell.value = product ? product.averageCost : null;
      cell.numFmt = '$0.00';
      cell.alignment = { horizontal: 'center' };
    });
  });

  productNames.forEach((name, productIndex) => {
    const ranked = trend
      .map((bucket) => ({ label: bucket.label, value: bucket.products.find((product) => product.name === name)?.averageCost || 0 }))
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
    to: { row: 5 + labels.length, column: lastMatrixColumn },
  };
  matrix.getColumn(1).width = 18;
  for (let column = 2; column <= lastMatrixColumn; column += 1) matrix.getColumn(column).width = 16;
  matrix.getRow(4).height = 32;
  matrix.getCell('B4').alignment = { wrapText: true, vertical: 'middle' };

  const opportunities = workbook.addWorksheet('Time Opportunities', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: false }],
  });
  applyTitle(opportunities, 10, 'Top Waste Opportunities by Time');
  opportunities.getCell('A2').value = 'Date range';
  opportunities.getCell('B2').value = startDayKey;
  opportunities.getCell('C2').value = endDayKey;
  opportunities.getCell('A3').value = 'How to read';
  opportunities.getCell('B3').value = 'Times are ranked by average waste dollars per logged day. The three largest product drivers are shown for each time.';
  opportunities.mergeCells('B3:J3');
  opportunities.getRow(5).values = [
    'Rank',
    grouping === 'hour' ? 'Hour' : 'Daypart',
    'Avg waste $',
    'Logged days',
    '#1 product',
    '#1 avg $',
    '#2 product',
    '#2 avg $',
    '#3 product',
    '#3 avg $',
  ];
  applyHeader(opportunities.getRow(5));
  trend.forEach((bucket, index) => {
    const top = bucket.products.slice(0, 3);
    const row = opportunities.getRow(index + 6);
    row.values = [
      index + 1,
      bucket.label,
      bucket.averageCost,
      bucket.loggedDays,
      top[0]?.name || '',
      top[0]?.averageCost ?? null,
      top[1]?.name || '',
      top[1]?.averageCost ?? null,
      top[2]?.name || '',
      top[2]?.averageCost ?? null,
    ];
    [3, 6, 8, 10].forEach((column) => {
      row.getCell(column).numFmt = '$0.00';
    });
    if (index < 3) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index === 0 ? YELLOW : LIGHT_BLUE } };
      row.font = { bold: true };
    } else if (index % 2 === 1) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALE_BLUE } };
    }
  });
  opportunities.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: 5 + trend.length, column: 10 },
  };
  [9, 18, 14, 13, 22, 13, 22, 13, 22, 13].forEach((width, index) => {
    opportunities.getColumn(index + 1).width = width;
  });
  opportunities.getRow(3).height = 32;
  opportunities.getCell('B3').alignment = { wrapText: true, vertical: 'middle' };

  const instructions = workbook.addWorksheet('Read Me', { views: [{ showGridLines: false }] });
  applyTitle(instructions, 6, 'How to Use This Waste Report');
  instructions.getColumn(1).width = 24;
  instructions.getColumn(2).width = 80;
  [
    ['Product by Time', 'Scan down a product column. Yellow cells are that product’s top three waste hours or dayparts.'],
    ['Time Opportunities', 'Start with rank 1. The sheet shows the top three products driving each hour or daypart.'],
    ['Average waste dollars', 'Total waste dollars for that product and time divided by the number of days that product/time was logged.'],
    ['Blank cells', 'No waste was logged for that product and time in the selected range.'],
    ['Demo data', 'Demo exports are isolated from live operational records.'],
  ].forEach(([label, description], index) => {
    const row = index + 3;
    instructions.getCell(row, 1).value = label;
    instructions.getCell(row, 1).font = { bold: true };
    instructions.getCell(row, 2).value = description;
    instructions.getCell(row, 2).alignment = { wrapText: true, vertical: 'top' };
    instructions.getRow(row).height = 34;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer as unknown as ArrayBuffer;
}
