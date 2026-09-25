import ExcelJS from 'exceljs';
import { PREP_ITEMS, prepTotals, promoFree, TABLE_ITEMS, type SaturdayPrepRecord } from './saturdayPrep';

export async function createSaturdayPrepWorkbook(records: SaturdayPrepRecord[], start: string, end: string, source: 'live' | 'demo' = 'live'): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('Daily totals');
  summary.addRow([source === 'demo' ? 'DEMO · Saturday Prep (sample data)' : 'Saturday Prep', start, end]);
  summary.addRow(['Date', 'Status', 'Table weight (lb)', 'Prepared waste (each)', 'Promo Free (each)', 'Tea waste (gal)', 'Tea Promo Free (gal)']);
  const table = workbook.addWorksheet('Table weights');
  table.addRow(['Date', 'Status', 'Item', 'Pounds', 'Ounces', 'Total weight (lb)']);
  const prep = workbook.addWorksheet('Prepared items');
  prep.addRow(['Date', 'Status', 'Item', 'Unit', 'At 10 p.m.', 'Left at 11 p.m. / wasted', 'Taken home / Promo Free']);
  for (const record of records) {
    const status = `${source === 'demo' ? 'DEMO · ' : ''}${record.submittedAt ? 'Submitted' : 'Draft — incomplete / not final'}`;
    const totals = prepTotals(record.values);
    summary.addRow([record.dayKey, status, totals.tableOunces / 16, totals.wastedEach,
      totals.promoEach, totals.wastedGallons, totals.promoGallons]);
    for (const [id, name] of TABLE_ITEMS) {
      const lb = record.values[`${id}_lb`] ?? null;
      const oz = record.values[`${id}_oz`] ?? null;
      table.addRow([record.dayKey, status, name, lb, oz, lb === null || oz === null ? null : lb + oz / 16]);
    }
    for (const [id, name] of PREP_ITEMS) {
      prep.addRow([record.dayKey, status, name, id === 'tea' ? 'gal' : 'each',
        record.values[`${id}_eod`] ?? null, record.values[`${id}_left`] ?? null, promoFree(record.values, id)]);
    }
  }
  for (const sheet of workbook.worksheets) {
    const headerRow = sheet === summary ? 2 : 1;
    sheet.views = [{ state: 'frozen', ySplit: headerRow }];
    sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
    sheet.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(headerRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243B53' } };
    sheet.getRow(headerRow).height = 32;
    sheet.columns.forEach((column, index) => {
      column.width = index === 0 ? 14 : index === 1 ? 33 : 28;
      column.alignment = { vertical: 'middle', wrapText: true };
    });
  }
  return await workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}
