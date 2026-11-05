// Excel import logic (pure functions; the web app reads the workbook with ExcelJS and passes plain cell values).
// Supports the original CESS_Machining_Job_Tracker.xlsx layout (ENTRY + VENDORS sheets) and the app's templates.
// The server validates everything again (import_jobs / import_vendors); this code maps columns, parses values and
// rebuilds "cancelled & forwarded" chains into one job with several vendor assignments.

export type Cell = string | number | boolean | Date | null | undefined;

export interface SheetData {
  name: string;
  rows: Cell[][]; // row 0 = first worksheet row
}

export type JobField =
  | "ref"
  | "part_label"
  | "description"
  | "qty_sent"
  | "category_name"
  | "given_by_name"
  | "vendor_name"
  | "dispatched_on"
  | "commitment_date"
  | "amount"
  | "returned_on"
  | "cancelled_on"
  | "forwarded_to"
  | "remarks";

export type VendorField = "ref" | "name" | "company_name" | "category_name" | "address" | "mobile" | "email" | "gst_no" | "contact_person";

const JOB_HEADERS: Record<JobField, string[]> = {
  ref: ["sr no", "sr. no", "s.no", "s no", "sr"],
  part_label: ["part no / name", "part no / part name", "part number / name", "part no/name", "part"],
  description: ["description", "part description"],
  qty_sent: ["quantity sent", "quantity", "qty", "qty sent"],
  category_name: ["work / machining process", "work category", "machining category", "work / machining category", "category", "work"],
  given_by_name: ["given by"],
  vendor_name: ["vendor name", "vendor"],
  dispatched_on: ["date given to vendor", "date given", "dispatch date"],
  commitment_date: ["vendor committed delivery date", "vendor committed date", "committed date", "commitment date"],
  amount: ["amount (₹)", "amount", "estimated amount (₹)", "estimated amount", "job amount"],
  returned_on: ["date returned by vendor", "date returned", "actual return date", "return date"],
  cancelled_on: ["cancelled on", "cancellation date"],
  forwarded_to: ["forwarded to"],
  remarks: ["remarks", "remark"],
};

const VENDOR_HEADERS: Record<VendorField, string[]> = {
  ref: ["sr no", "sr. no", "s.no"],
  name: ["vendor name", "vendor"],
  company_name: ["company name", "company"],
  category_name: ["work category", "category"],
  address: ["address"],
  mobile: ["phone no", "phone", "mobile", "mobile number", "phone number"],
  email: ["email", "e-mail"],
  gst_no: ["gst no", "gst number", "gstin", "gst"],
  contact_person: ["contact person", "contact"],
};

export function normalizeHeader(v: Cell): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function findHeader<F extends string>(sheet: SheetData, spec: Record<F, string[]>, required: F[]): { row: number; columns: Partial<Record<F, number>> } | null {
  for (let r = 0; r < Math.min(sheet.rows.length, 20); r++) {
    const cells = (sheet.rows[r] ?? []).map(normalizeHeader);
    const columns: Partial<Record<F, number>> = {};
    for (const field of Object.keys(spec) as F[]) {
      const idx = cells.findIndex((c) => spec[field].includes(c));
      if (idx >= 0) columns[field] = idx;
    }
    if (required.every((f) => columns[f] !== undefined)) return { row: r, columns };
  }
  return null;
}

// ------------------------------------------------------------------ value parsing
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Excel dates: Date objects, Excel serial numbers, or text in Indian day-first formats. */
export function parseDateCell(v: Cell): { value: string | null; error: string | null } {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return { value: null, error: null };
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return { value: null, error: "invalid date" };
    // ExcelJS gives dates as UTC midnight; add 12 h before reading the day to be safe against offsets
    const t = new Date(v.getTime() + 12 * 3_600_000);
    return { value: iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()), error: null };
  }
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return { value: null, error: `"${v}" is not a date` };
    const t = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000);
    return { value: iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()), error: null };
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) {
    const r = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    return r ? { value: r, error: null } : { value: null, error: `"${s}" is not a valid date` };
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const r = iso(y, Number(m[2]), Number(m[1])); // day first (India)
    return r ? { value: r, error: null } : { value: null, error: `"${s}" is not a valid date (day/month/year)` };
  }
  m = /^(\d{1,2})[-\s/]([A-Za-z]+)[-\s/,]+(\d{2}|\d{4})$/.exec(s);
  const month = m ? MONTHS[m[2]!.toLowerCase().slice(0, 3)] : undefined;
  if (m && month) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const r = iso(y, month, Number(m[1]));
    return r ? { value: r, error: null } : { value: null, error: `"${s}" is not a valid date` };
  }
  return { value: null, error: `"${s}" is not a recognised date (use DD-MM-YYYY)` };
}

export function parseAmountCell(v: Cell): { value: number | null; error: string | null } {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return { value: null, error: null };
  const n = typeof v === "number" ? v : Number(String(v).replace(/[₹,\s]|rs\.?|inr/gi, ""));
  if (!Number.isFinite(n) || n < 0) return { value: null, error: `"${String(v)}" is not an amount` };
  return { value: Math.round(n * 100) / 100, error: null };
}

export function parseQtyCell(v: Cell): { value: number | null; error: string | null } {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return { value: null, error: null };
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]|nos?\.?|pcs\.?/gi, ""));
  if (!Number.isInteger(n) || n < 1) return { value: null, error: `"${String(v)}" is not a whole quantity` };
  return { value: n, error: null };
}

function text(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

// ------------------------------------------------------------------ jobs
export interface ParsedJobRow {
  rowNumber: number; // worksheet row number (1-based) for messages
  ref: string;
  part_label: string;
  description: string;
  qty_sent: number | null;
  category_name: string;
  given_by_name: string;
  vendor_name: string;
  dispatched_on: string | null;
  commitment_date: string | null;
  amount: number | null;
  returned_on: string | null;
  cancelled_on: string | null;
  forwarded_to: string;
  remarks: string;
}

export interface ImportAssignment {
  vendor_name: string;
  dispatched_on: string;
  commitment_date: string | null;
  amount: number | null;
  returned_on: string | null;
  cancelled_on: string | null;
  remarks: string;
}

export interface ImportJobGroup {
  ref: string;
  rows: number[];
  part_label: string;
  description: string;
  category_name: string;
  given_by_name: string;
  qty_sent: number | null;
  remarks: string;
  assignments: ImportAssignment[];
  warnings: string[];
}

export interface RowProblem {
  rowNumber: number;
  message: string;
}

export interface JobsParseResult {
  layout: "cess-tracker" | "template";
  sheet: string;
  headerRow: number;
  rows: ParsedJobRow[];
  rowErrors: RowProblem[];
  groups: ImportJobGroup[];
}

export function parseJobsSheet(sheets: SheetData[]): JobsParseResult | { error: string } {
  const candidates = [...sheets].sort((a, b) => Number(/^(entry|jobs)$/i.test(b.name)) - Number(/^(entry|jobs)$/i.test(a.name)));
  for (const sheet of candidates) {
    const header = findHeader<JobField>(sheet, JOB_HEADERS, ["part_label", "vendor_name", "dispatched_on"]);
    if (!header) continue;
    const c = header.columns;
    const get = (row: Cell[], f: JobField): Cell => (c[f] === undefined ? null : row[c[f]!]);
    const rows: ParsedJobRow[] = [];
    const rowErrors: RowProblem[] = [];
    for (let r = header.row + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      const part = text(get(row, "part_label"));
      const vendor = text(get(row, "vendor_name"));
      const anyData = (["part_label", "vendor_name", "dispatched_on", "returned_on", "amount", "cancelled_on"] as JobField[]).some((f) => text(get(row, f)) !== "");
      if (!anyData) continue; // empty table row
      const rowNumber = r + 1;
      const problems: string[] = [];
      if (!part) problems.push("Part No / Name is empty");
      if (!vendor) problems.push("Vendor name is empty");
      const dates = Object.fromEntries(
        (["dispatched_on", "commitment_date", "returned_on", "cancelled_on"] as const).map((f) => {
          const p = parseDateCell(get(row, f));
          if (p.error) problems.push(`${f.replace("_", " ")}: ${p.error}`);
          return [f, p.value];
        }),
      ) as Record<"dispatched_on" | "commitment_date" | "returned_on" | "cancelled_on", string | null>;
      if (!dates.dispatched_on && !problems.some((p) => p.startsWith("dispatched"))) problems.push("Date given to vendor is empty");
      const amount = parseAmountCell(get(row, "amount"));
      if (amount.error) problems.push(`Amount: ${amount.error}`);
      const qty = parseQtyCell(get(row, "qty_sent"));
      if (qty.error) problems.push(`Quantity: ${qty.error}`);
      if (problems.length) {
        rowErrors.push({ rowNumber, message: problems.join("; ") });
        continue;
      }
      rows.push({
        rowNumber,
        ref: text(get(row, "ref")) || `Row ${rowNumber}`,
        part_label: part,
        description: text(get(row, "description")),
        qty_sent: qty.value,
        category_name: text(get(row, "category_name")),
        given_by_name: text(get(row, "given_by_name")),
        vendor_name: vendor,
        dispatched_on: dates.dispatched_on,
        commitment_date: dates.commitment_date,
        amount: amount.value,
        returned_on: dates.returned_on,
        cancelled_on: dates.cancelled_on,
        forwarded_to: text(get(row, "forwarded_to")),
        remarks: text(get(row, "remarks")),
      });
    }
    const layout = /^entry$/i.test(sheet.name) || normalizeHeader((sheet.rows[header.row] ?? [])[c.part_label!]) === "part no / name" ? "cess-tracker" : "template";
    return { layout, sheet: sheet.name, headerRow: header.row + 1, rows, rowErrors, groups: buildJobGroups(rows) };
  }
  return { error: 'No sheet with the columns "Part No / Name", "Vendor Name" and "Date Given to Vendor" was found.' };
}

const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Rebuilds the Excel "cancel & forward" practice: a row with Cancelled On + Forwarded To, followed later by a row for the
 * same part with that vendor, becomes ONE job with two vendor assignments (history preserved).
 */
export function buildJobGroups(rows: ParsedJobRow[]): ImportJobGroup[] {
  const groups: ImportJobGroup[] = [];
  const waiting = new Map<string, { group: ImportJobGroup; vendor: string }>(); // part -> group waiting for forwarded vendor
  for (const r of rows) {
    const partKey = key(r.part_label);
    const pending = waiting.get(partKey);
    let group: ImportJobGroup;
    if (pending && pending.vendor === key(r.vendor_name)) {
      group = pending.group;
      waiting.delete(partKey);
      group.rows.push(r.rowNumber);
      group.ref = `${group.ref}, ${r.ref}`;
      if (r.remarks && !group.remarks.includes(r.remarks)) group.remarks = group.remarks ? `${group.remarks}; ${r.remarks}` : r.remarks;
      if (group.qty_sent === null && r.qty_sent !== null) group.qty_sent = r.qty_sent;
    } else {
      if (pending) {
        pending.group.warnings.push(`Forwarded to "${pending.vendor}" but the next row for this part is for "${r.vendor_name}"; imported as cancelled.`);
        waiting.delete(partKey);
      }
      group = {
        ref: r.ref,
        rows: [r.rowNumber],
        part_label: r.part_label,
        description: r.description,
        category_name: r.category_name,
        given_by_name: r.given_by_name,
        qty_sent: r.qty_sent,
        remarks: r.remarks,
        assignments: [],
        warnings: [],
      };
      groups.push(group);
    }
    group.assignments.push({
      vendor_name: r.vendor_name,
      dispatched_on: r.dispatched_on!,
      commitment_date: r.commitment_date,
      amount: r.amount,
      returned_on: r.returned_on,
      cancelled_on: r.cancelled_on,
      remarks: r.remarks,
    });
    if (r.cancelled_on && r.forwarded_to) waiting.set(partKey, { group, vendor: key(r.forwarded_to) });
    if (!r.cancelled_on && r.forwarded_to) group.warnings.push(`Row ${r.rowNumber}: "Forwarded To" is filled but "Cancelled On" is empty; forwarding ignored.`);
  }
  for (const { group, vendor } of waiting.values()) {
    group.warnings.push(`Forwarded to "${vendor}" but no later row for that vendor was found; imported as cancelled.`);
  }
  return groups;
}

/** Payload for the import_jobs database function. */
export function toImportPayload(groups: ImportJobGroup[]) {
  return groups.map((g) => ({
    ref: g.ref,
    part_label: g.part_label,
    category_name: g.category_name,
    given_by_name: g.given_by_name,
    qty_sent: g.qty_sent,
    remarks: [g.description, g.remarks].filter(Boolean).join(" | "),
    assignments: g.assignments,
  }));
}

// ------------------------------------------------------------------ vendors
export interface ParsedVendorRow {
  rowNumber: number;
  ref: string;
  name: string;
  company_name: string;
  category_name: string;
  address: string;
  mobile: string;
  email: string;
  gst_no: string;
  contact_person: string;
}

export function parseVendorsSheet(sheets: SheetData[]): { sheet: string; rows: ParsedVendorRow[] } | null {
  const candidates = [...sheets].sort((a, b) => Number(/^vendors?$/i.test(b.name)) - Number(/^vendors?$/i.test(a.name)));
  for (const sheet of candidates) {
    if (/^(entry|jobs)$/i.test(sheet.name)) continue;
    const header = findHeader<VendorField>(sheet, VENDOR_HEADERS, ["name"]);
    if (!header || header.columns.company_name === undefined && header.columns.mobile === undefined && header.columns.gst_no === undefined) continue;
    const c = header.columns;
    const rows: ParsedVendorRow[] = [];
    for (let r = header.row + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      const g = (f: VendorField) => (c[f] === undefined ? "" : text(row[c[f]!]));
      if (!g("name")) continue;
      rows.push({
        rowNumber: r + 1,
        ref: g("ref") || `Row ${r + 1}`,
        name: g("name"),
        company_name: g("company_name"),
        category_name: g("category_name"),
        address: g("address"),
        mobile: g("mobile"),
        email: g("email"),
        gst_no: g("gst_no").toUpperCase(),
        contact_person: g("contact_person"),
      });
    }
    return { sheet: sheet.name, rows };
  }
  return null;
}

/** Column headers of the downloadable import templates. */
export const JOB_TEMPLATE_HEADERS = [
  "Part No / Part Name",
  "Description",
  "Quantity Sent",
  "Work Category",
  "Given By",
  "Vendor Name",
  "Date Given to Vendor",
  "Vendor Committed Date",
  "Estimated Amount (₹)",
  "Date Returned",
  "Cancelled On",
  "Forwarded To",
  "Remarks",
];
export const VENDOR_TEMPLATE_HEADERS = ["Vendor Name", "Company Name", "Contact Person", "Work Category", "Phone No", "Email", "GST No", "Address"];
