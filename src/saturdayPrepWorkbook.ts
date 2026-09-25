import ExcelJS from 'exceljs';
import { PREP_ITEMS, prepValidation, promoFree, TABLE_ITEMS, type SaturdayPrepRecord } from './saturdayPrep';

export async function createSaturdayPrepWorkbook(records: SaturdayPrepRecord[], start: string, end: string, source: 'live' | 'demo' = 'live'): Promise<ArrayBuffer> {
  const inRange = records.filter((record) => record.dayKey >= start && record.dayKey <= end);
  const submitted = inRange.filter((record) => record.submittedAt && prepValidation(record.values).length === 0);
  const excluded = inRange.length - submitted.length;
  if (!submitted.length) throw new Error('No completed, submitted Saturday Prep logs were found in this date range.');
  const workbook = new ExcelJS.Workbook();
  const table = workbook.addWorksheet('Table weights');
  const prep = workbook.addWorksheet('Prepared items');
  const title = source === 'demo' ? 'DEMO · Saturday Prep (sample data)' : 'Saturday Prep';
  for (const sheet of [table, prep]) {
    sheet.addRow([title]);
    sheet.addRow(['Date range', start, 'through', end]);
    sheet.addRow([`${submitted.length} submitted Saturday log(s) included${excluded ? ` · ${excluded} draft or incomplete log(s) excluded` : ''}`]);
    sheet.mergeCells('A1:D1');
    sheet.mergeCells('A3:D3');
  }
  table.addRow(['Table item', 'Total weight (lb)', 'Pounds', 'Ounces']);
  prep.addRow(['Prepared item', 'Unit', 'Total wasted', 'Total Promo Free']);
  for (const [id, name] of TABLE_ITEMS) {
    const ounces = submitted.reduce((sum, record) => sum + record.values[`${id}_lb`]! * 16 + record.values[`${id}_oz`]!, 0);
    table.addRow([name, ounces / 16, Math.floor(ounces / 16), Number((ounces % 16).toFixed(10))]);
  }
  for (const [id, name] of PREP_ITEMS) {
    const wasted = submitted.reduce((sum, record) => sum + record.values[`${id}_left`]!, 0);
    const promo = submitted.reduce((sum, record) => sum + promoFree(record.values, id)!, 0);
    prep.addRow([name, id === 'tea' ? 'gal' : 'each', Number(wasted.toFixed(10)), Number(promo.toFixed(10))]);
  }
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: 'frozen', ySplit: 4 }];
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: sheet.rowCount, column: 4 } };
    sheet.getRow(1).font = { bold: true, size: 16 };
    sheet.getRow(1).height = 30;
    sheet.getRow(3).height = 32;
    sheet.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF243B53' } };
    sheet.getRow(4).height = 32;
    sheet.columns.forEach((column, index) => {
      column.width = index === 0 ? 43 : 23;
      column.alignment = { vertical: 'middle', wrapText: true };
    });
    sheet.eachRow((row, index) => {
      if (index > 4) {
        row.height = 30;
        row.eachCell((cell) => { if (typeof cell.value === 'number') cell.numFmt = '0.##########'; });
      }
    });
  }
  return await workbook.xlsx.writeBuffer() as unknown as ArrayBuffer;
}
