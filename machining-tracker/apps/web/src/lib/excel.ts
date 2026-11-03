// Excel read/write in the browser with ExcelJS (loaded only when needed).
import type { Cell, SheetData } from "@cess/shared";

async function excel() {
  const mod = await import("exceljs");
  return (mod as unknown as { default?: typeof import("exceljs") }).default ?? mod;
}

function plain(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  const o = v as { result?: unknown; text?: string; richText?: Array<{ text: string }>; error?: string; hyperlink?: string };
  if (o.richText) return o.richText.map((t) => t.text).join("");
  if ("result" in o) return plain(o.result);
  if (o.text !== undefined) return o.text;
  if (o.error) return null;
  return String(v);
}

export async function readWorkbook(file: File): Promise<{ sheets: SheetData[]; sha256: string }> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets: SheetData[] = wb.worksheets.map((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      rows[n - 1] = (row.values as unknown[]).slice(1).map(plain);
    });
    return { name: ws.name, rows: Array.from(rows, (r) => r ?? []) };
  });
  return { sheets, sha256 };
}

export interface ExportColumn<T> {
  header: string;
  width?: number;
  value: (row: T) => string | number | Date | null | undefined;
  format?: "date" | "inr" | "int";
}

export interface ExportSheet<T> {
  name: string;
  title?: string;
  columns: ExportColumn<T>[];
  rows: T[];
}

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  return new Date(`${v.slice(0, 10)}T00:00:00Z`);
}

// Each sheet can have its own row type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySheet = ExportSheet<any>;

export async function downloadWorkbook(fileName: string, sheets: AnySheet[]): Promise<void> {
  const ExcelJS = await excel();
  const wb = new ExcelJS.Workbook();
  wb.creator = "CESS Machining Tracker";
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31), { views: [{ state: "frozen", ySplit: s.title ? 2 : 1 }] });
    if (s.title) {
      ws.addRow([s.title]).font = { bold: true, size: 12 };
    }
    const header = ws.addRow(s.columns.map((c) => c.header));
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B3A7A" } };
    for (const row of s.rows) {
      ws.addRow(
        s.columns.map((c) => {
          const v = c.value(row);
          if (c.format === "date") return toDate(v) ?? v ?? null;
          if (c.format === "inr" || c.format === "int") return v === null || v === undefined || v === "" ? null : Number(v);
          return v ?? null;
        }),
      );
    }
    s.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.width ?? Math.max(12, c.header.length + 2);
      if (c.format === "date") col.numFmt = "dd-mmm-yyyy";
      if (c.format === "inr") col.numFmt = '"₹"#,##,##0.00';
    });
    ws.autoFilter = { from: { row: s.title ? 2 : 1, column: 1 }, to: { row: s.title ? 2 : 1, column: s.columns.length } };
  }
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
