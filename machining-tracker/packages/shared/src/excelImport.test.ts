import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildJobGroups, parseDateCell, parseJobsSheet, parseVendorsSheet, toImportPayload, type Cell, type SheetData } from "./excelImport";
import { formatINR } from "./format";

const ENTRY_HEADER = [
  "Sr No", "Part No / Name", "Date Given to Vendor", "Date Returned by Vendor", "Vendor Name", "Given By",
  "Work / Machining Process", "Amount (₹)", "Days Taken", "Status", "Cancelled On", "Forwarded To", "Remarks",
  "h_vfirst", "h_vnum",
];

function entrySheet(rows: Cell[][]): SheetData {
  return {
    name: "ENTRY",
    rows: [["MACHINING JOB ENTRY"], ["Enter only the white columns..."], [], ["Go to DASHBOARD"], ENTRY_HEADER, ...rows],
  };
}

describe("date parsing (Indian day-first formats)", () => {
  it.each([
    [new Date(Date.UTC(2026, 10, 1)), "2026-11-01"],
    [46327, "2026-11-01"], // Excel serial
    ["01-11-2026", "2026-11-01"],
    ["1/11/2026", "2026-11-01"],
    ["01.11.26", "2026-11-01"],
    ["01-Nov-2026", "2026-11-01"],
    ["1 November 2026", "2026-11-01"],
    ["2026-11-01", "2026-11-01"],
  ] as Array<[Cell, string]>)("%s -> %s", (input, expected) => {
    expect(parseDateCell(input)).toEqual({ value: expected, error: null });
  });
  it("rejects impossible dates instead of guessing", () => {
    expect(parseDateCell("31-02-2026").error).not.toBeNull();
    expect(parseDateCell("next week").error).not.toBeNull();
    expect(parseDateCell(12.5).error).not.toBeNull();
    expect(parseDateCell("")).toEqual({ value: null, error: null });
  });
});

describe("original CESS tracker layout (ENTRY sheet)", () => {
  it("finds the header row and maps the columns", () => {
    const r = parseJobsSheet([entrySheet([[1, "4711 / Shaft", "01-11-2026", null, "Shree Engg", "Samyak", "CNC Turning", 12500, 3, "Pending", null, null, "urgent"]])]);
    if ("error" in r) throw new Error(r.error);
    expect(r.layout).toBe("cess-tracker");
    expect(r.headerRow).toBe(5);
    expect(r.rows[0]).toMatchObject({
      rowNumber: 6, part_label: "4711 / Shaft", dispatched_on: "2026-11-01", vendor_name: "Shree Engg", given_by_name: "Samyak",
      category_name: "CNC Turning", amount: 12500, qty_sent: null, commitment_date: null, remarks: "urgent",
    });
  });

  it("rebuilds cancel-and-forward chains as one job with the full vendor journey", () => {
    const r = parseJobsSheet([
      entrySheet([
        [1, "P-100 / Flange", "01-11-2026", null, "Vendor A", "Vansh", "VMC Machining", 5000, null, null, "08-11-2026", "Vendor B", "late"],
        [2, "P-200 / Pin", "02-11-2026", "06-11-2026", "Vendor C", "Sanjay", "Grinding", 800, null, null, null, null, null],
        [3, "P-100 / Flange", "08-11-2026", null, "Vendor B", "Vansh", "VMC Machining", 5600, null, null, null, null, null],
        [4, "P-300 / Gear", "03-11-2026", null, "Vendor D", "Samyak", "Gear Cutting", null, null, null, "05-11-2026", null, "not needed"],
      ]),
    ]);
    if ("error" in r) throw new Error(r.error);
    expect(r.groups).toHaveLength(3);
    const flange = r.groups.find((g) => g.part_label === "P-100 / Flange")!;
    expect(flange.rows).toEqual([6, 8]);
    expect(flange.assignments.map((a) => [a.vendor_name, a.cancelled_on])).toEqual([
      ["Vendor A", "2026-11-08"],
      ["Vendor B", null],
    ]);
    const gear = r.groups.find((g) => g.part_label === "P-300 / Gear")!;
    expect(gear.assignments).toHaveLength(1);
    expect(gear.assignments[0]!.cancelled_on).toBe("2026-11-05");
    expect(toImportPayload(r.groups)[0]).toMatchObject({ part_label: "P-100 / Flange", category_name: "VMC Machining" });
  });

  it("warns when a forwarded vendor row is missing", () => {
    const groups = buildJobGroups([
      { rowNumber: 6, ref: "1", part_label: "X", description: "", qty_sent: 5, category_name: "Others", given_by_name: "", vendor_name: "A", dispatched_on: "2026-11-01", commitment_date: null, amount: null, returned_on: null, cancelled_on: "2026-11-02", forwarded_to: "B", remarks: "" },
    ]);
    expect(groups[0]!.warnings[0]).toMatch(/no later row/);
  });

  it("reports rows with missing or invalid data instead of importing them", () => {
    const r = parseJobsSheet([
      entrySheet([
        [1, "", "01-11-2026", null, "Vendor A", "Vansh", "VMC Machining"],
        [2, "Part", "31-02-2026", null, "Vendor A", "Vansh", "VMC Machining"],
        [3, "Part 2", "01-11-2026", null, "Vendor A", "Vansh", "VMC Machining", "abc"],
        [null, null, null, null, null, null, null, null, 0, ""],
      ]),
    ]);
    if ("error" in r) throw new Error(r.error);
    expect(r.rows).toHaveLength(0);
    expect(r.rowErrors.map((e) => e.rowNumber)).toEqual([6, 7, 8]);
    expect(r.rowErrors[0]!.message).toMatch(/Part No \/ Name is empty/);
    expect(r.rowErrors[2]!.message).toMatch(/Amount/);
  });
});

describe("the real workbook from the Excel tracker", () => {
  it("is recognised (it is an empty template: no job or vendor rows)", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(new URL("../../../../legacy/CESS_Machining_Job_Tracker.xlsx", import.meta.url).pathname);
    const sheets: SheetData[] = wb.worksheets.map((ws) => {
      const rows: Cell[][] = [];
      ws.eachRow({ includeEmpty: true }, (row, n) => {
        rows[n - 1] = (row.values as unknown[]).slice(1).map((v) => {
          if (v && typeof v === "object" && !(v instanceof Date)) {
            const o = v as { result?: Cell; text?: string; richText?: Array<{ text: string }> };
            return o.result ?? o.text ?? o.richText?.map((t) => t.text).join("") ?? null;
          }
          return v as Cell;
        });
      });
      return { name: ws.name, rows };
    });
    const jobs = parseJobsSheet(sheets);
    if ("error" in jobs) throw new Error(jobs.error);
    expect(jobs.layout).toBe("cess-tracker");
    expect(jobs.rows).toEqual([]);
    expect(jobs.groups).toEqual([]);
    const vendors = parseVendorsSheet(sheets);
    expect(vendors?.sheet).toBe("VENDORS");
    expect(vendors?.rows).toEqual([]);
  });
});

describe("vendor sheet", () => {
  it("maps the VENDORS columns", () => {
    const v = parseVendorsSheet([
      { name: "VENDORS", rows: [["VENDOR MASTER"], [], [], [], ["Sr No", "Vendor Name", "Company Name", "Work Category", "Address", "Phone No", "Email", "GST No"], [1, "Shree Engg", "Shree Engineering Works", "CNC Turning", "MIDC", "98220 12345", "a@b.in", "27abcde1234f1z5"]] },
    ]);
    expect(v?.rows[0]).toMatchObject({ name: "Shree Engg", company_name: "Shree Engineering Works", category_name: "CNC Turning", mobile: "98220 12345", gst_no: "27ABCDE1234F1Z5" });
  });
});

describe("currency", () => {
  it("formats rupees with Indian grouping", () => {
    expect(formatINR(1250000)).toBe("₹12,50,000.00");
    expect(formatINR(null)).toBe("");
  });
});
