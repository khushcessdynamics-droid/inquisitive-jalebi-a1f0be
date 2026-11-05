// Weekly management report: one description of the content, used by the screen, the Excel file and the PDF,
// so all three always show the same figures. Missing values stay "—" (never 0); every definition is stated.
import { formatDate, formatDateTimeIST, formatINR, type DateFormat } from "@cess/shared";
import { downloadWorkbook, type ExportSheet } from "./excel";

type N = number | null | undefined;
interface VendorRow {
  vendor_id?: string;
  vendor_name: string;
  score?: number;
  label?: string;
  eligible_jobs?: number;
  overdue_jobs?: number;
  max_delay_days?: number | null;
  revisions?: number;
  by_vendor?: number;
  paid?: number;
  category_name?: string;
}
interface JobRow {
  id?: string;
  job_id?: string;
  job_no: string;
  part_label: string;
  vendor_name: string;
  current_commitment_date?: string;
  delay_days_current?: number;
  qty_with_vendor?: number | null;
  returned_on?: string;
  qty_uninspected?: number;
  total_payable?: number;
  paid?: number;
  balance?: number;
}
export interface WeeklyReport {
  id: string;
  kind: "scheduled" | "manual";
  generated_at: string;
  generated_by_name: string | null;
  data: {
    period: { start: string; end: string };
    generated_on: string;
    jobs: { new: number; completed: number; cancelled: number; pending_now: number; overdue_now: number; partially_returned_now: number; inspection_pending_now: number };
    delivery: { due: number; completed_on_time: number; completed_late: number; completed_no_commitment: number; avg_delay_days: N; vendors_revised: VendorRow[] };
    vendors: { fy: string; best: VendorRow[]; lowest: VendorRow[]; scored_vendors: number; by_category: VendorRow[]; most_overdue: VendorRow[] };
    quality: { qty_sent: number; jobs_without_qty: number; qty_returned: number; inspected: number; accepted: number; rejected: number; rework: number; acceptance_pct: N };
    followups: { due_next_week: JobRow[]; overdue: JobRow[]; pending_inspections: JobRow[] };
    previous: {
      period: { start: string; end: string };
      jobs: { new: number; completed: number; cancelled: number };
      delivery: { due: number; completed_on_time: number; completed_late: number; completed_no_commitment: number; avg_delay_days: N };
      quality: WeeklyReport["data"]["quality"];
      snapshot_from_report: { generated_at: string; pending_now: number; overdue_now: number; partially_returned_now: number } | null;
    };
  };
  financial: {
    total_job_value: number;
    jobs_without_amount: number;
    payments_made: number;
    outstanding: number;
    spending_by_vendor: VendorRow[];
    pending_payments: JobRow[];
    previous: { total_job_value: number; jobs_without_amount: number; payments_made: number; outstanding_from_report?: number };
  } | null;
}

export interface Metric {
  label: string;
  value: string;
  previous: string;
  change: string;
  note?: string;
}
export interface ListTable {
  title: string;
  columns: string[];
  rows: string[][];
  empty: string;
  links?: Array<string | null>;
}
export interface Section {
  key: string;
  title: string;
  metrics: Metric[];
  tables: ListTable[];
  note?: string;
}

const dash = "—";
const num = (v: N) => (v === null || v === undefined ? dash : String(v));
const pct = (v: N) => (v === null || v === undefined ? dash : `${v.toFixed(1)}%`);
function change(a: N, b: N, money?: (n: number) => string): string {
  if (a === null || a === undefined || b === null || b === undefined) return dash;
  const d = Math.round((a - b) * 100) / 100;
  if (d === 0) return "no change";
  return `${d > 0 ? "+" : "−"}${money ? money(Math.abs(d)) : Math.abs(d)}`;
}

export function buildSections(r: WeeklyReport, fmt: DateFormat, money: (n: number) => string = (n) => formatINR(n)): Section[] {
  const d = r.data;
  const p = d.previous;
  const snap = p.snapshot_from_report;
  const date = (v?: string) => (v ? formatDate(v, fmt) : dash);
  const m = (label: string, a: N, b: N, note?: string, f: (v: N) => string = num, money2?: (n: number) => string): Metric => ({
    label,
    value: f(a),
    previous: f(b),
    change: change(a, b, money2),
    note,
  });
  const sections: Section[] = [
    {
      key: "A",
      title: "Job summary",
      note: '"Now" figures are as at the time the report was made; for the previous week they come from last week\'s report (if one was made).',
      metrics: [
        m("New jobs (started in the week)", d.jobs.new, p.jobs.new),
        m("Completed jobs", d.jobs.completed, p.jobs.completed),
        m("Cancelled jobs (all vendors cancelled)", d.jobs.cancelled, p.jobs.cancelled),
        m("Pending jobs now (not completed or cancelled)", d.jobs.pending_now, snap?.pending_now),
        m("Overdue jobs now", d.jobs.overdue_now, snap?.overdue_now),
        m("Partially returned jobs now", d.jobs.partially_returned_now, snap?.partially_returned_now),
      ],
      tables: [],
    },
    {
      key: "B",
      title: "Delivery performance",
      note: "On time / late against the ORIGINAL committed date, for vendor assignments completed in the week.",
      metrics: [
        m("Jobs due this week (latest committed date in the week)", d.delivery.due, p.delivery.due),
        m("Completed on time", d.delivery.completed_on_time, p.delivery.completed_on_time),
        m("Completed late", d.delivery.completed_late, p.delivery.completed_late),
        m("Completed without a committed date (not judged)", d.delivery.completed_no_commitment, p.delivery.completed_no_commitment),
        m("Average delay of late jobs (days)", d.delivery.avg_delay_days, p.delivery.avg_delay_days, "Empty when nothing was late"),
      ],
      tables: [
        {
          title: "Vendors with revised commitments in the week",
          columns: ["Vendor", "Revisions", "Requested by vendor"],
          rows: d.delivery.vendors_revised.map((v) => [v.vendor_name, num(v.revisions), num(v.by_vendor)]),
          empty: "No commitment was revised in the week.",
        },
      ],
    },
    {
      key: "C",
      title: `Vendor performance (reliability score, FY ${d.vendors.fy})`,
      note: `${d.vendors.scored_vendors} vendors have enough jobs for a score; vendors with too few jobs are not ranked.`,
      metrics: [],
      tables: [
        { title: "Best performing vendors", columns: ["Vendor", "Score", "Label", "Jobs"], rows: d.vendors.best.map((v) => [v.vendor_name, v.score!.toFixed(1), v.label ?? "", num(v.eligible_jobs)]), empty: "No vendor has a score yet." },
        { title: "Lowest reliability vendors", columns: ["Vendor", "Score", "Label", "Jobs"], rows: d.vendors.lowest.map((v) => [v.vendor_name, v.score!.toFixed(1), v.label ?? "", num(v.eligible_jobs)]), empty: "No vendor has a score yet." },
        { title: "Best vendor per category", columns: ["Category", "Vendor", "Score", "Jobs"], rows: d.vendors.by_category.map((v) => [v.category_name ?? "", v.vendor_name, v.score!.toFixed(1), num(v.eligible_jobs)]), empty: "No category has a scored vendor yet." },
        { title: "Vendors with most overdue jobs (now)", columns: ["Vendor", "Overdue jobs", "Longest delay (days)"], rows: d.vendors.most_overdue.map((v) => [v.vendor_name, num(v.overdue_jobs), num(v.max_delay_days)]), empty: "No overdue jobs." },
      ],
    },
  ];
  if (r.financial) {
    const f = r.financial;
    sections.push({
      key: "D",
      title: "Financial summary",
      note: "Job value = job amounts of vendor assignments given in the week. Payments by payment date, reversals subtracted.",
      metrics: [
        m("Total job value (given in the week)", f.total_job_value, f.previous.total_job_value, f.jobs_without_amount ? `${f.jobs_without_amount} job(s) without an amount are not included` : undefined, (v) => (v === null || v === undefined ? dash : money(v)), money),
        m("Payments made", f.payments_made, f.previous.payments_made, undefined, (v) => (v === null || v === undefined ? dash : money(v)), money),
        m("Outstanding now", f.outstanding, f.previous.outstanding_from_report, undefined, (v) => (v === null || v === undefined ? dash : money(v)), money),
      ],
      tables: [
        { title: "Weekly vendor spending", columns: ["Vendor", "Paid"], rows: f.spending_by_vendor.map((v) => [v.vendor_name, money(v.paid ?? 0)]), empty: "No payments in the week." },
      ],
    });
  }
  sections.push({
    key: "E",
    title: "Quality summary",
    note: "Sent = quantities given in the week; returned and inspected = entries dated in the week. Rework counts as not accepted.",
    metrics: [
      m("Total quantity sent", d.quality.qty_sent, p.quality.qty_sent, d.quality.jobs_without_qty ? `${d.quality.jobs_without_qty} job(s) without a quantity are not included` : undefined),
      m("Total quantity returned", d.quality.qty_returned, p.quality.qty_returned),
      m("Accepted quantity", d.quality.accepted, p.quality.accepted),
      m("Rejected quantity", d.quality.rejected, p.quality.rejected),
      m("Rework quantity", d.quality.rework, p.quality.rework),
      m("Quality acceptance %", d.quality.acceptance_pct, p.quality.acceptance_pct, "Empty when nothing was inspected", pct),
    ],
    tables: [],
  });
  const fu = d.followups;
  sections.push({
    key: "F",
    title: "Important follow-ups",
    metrics: [],
    tables: [
      { title: "Jobs due next week", columns: ["Job", "Part", "Vendor", "Committed", "With vendor"], rows: fu.due_next_week.map((j) => [j.job_no, j.part_label, j.vendor_name, date(j.current_commitment_date), num(j.qty_with_vendor)]), links: fu.due_next_week.map((j) => j.id ?? null), empty: "Nothing due next week." },
      { title: "Overdue jobs requiring action", columns: ["Job", "Part", "Vendor", "Committed", "Days late"], rows: fu.overdue.map((j) => [j.job_no, j.part_label, j.vendor_name, date(j.current_commitment_date), num(j.delay_days_current)]), links: fu.overdue.map((j) => j.id ?? null), empty: "No overdue jobs." },
      { title: "Pending quality inspections", columns: ["Job", "Part", "Vendor", "Returned", "Pieces to inspect"], rows: fu.pending_inspections.map((j) => [j.job_no, j.part_label, j.vendor_name, date(j.returned_on), num(j.qty_uninspected)]), links: fu.pending_inspections.map((j) => j.job_id ?? null), empty: "Nothing waiting for inspection." },
      ...(r.financial
        ? [{ title: "Pending vendor payments", columns: ["Job", "Vendor", "Payable", "Paid", "Balance"], rows: r.financial.pending_payments.map((j) => [j.job_no, j.vendor_name, money(j.total_payable ?? 0), money(j.paid ?? 0), money(j.balance ?? 0)]), links: r.financial.pending_payments.map((j) => j.job_id ?? null), empty: "No pending payments." }]
        : []),
    ],
  });
  return sections;
}

export function reportTitle(r: WeeklyReport, fmt: DateFormat): string {
  return `Weekly management report: ${formatDate(r.data.period.start, fmt)} to ${formatDate(r.data.period.end, fmt)}`;
}

export async function downloadReportExcel(r: WeeklyReport, fmt: DateFormat, company: string): Promise<void> {
  const sections = buildSections(r, fmt);
  type Line = { section: string; metric: string; value: string; previous: string; change: string; note: string };
  const summary: ExportSheet<Line> = {
    name: "Summary",
    title: `${company ? `${company} - ` : ""}${reportTitle(r, fmt)} (compared with ${formatDate(r.data.previous.period.start, fmt)} to ${formatDate(r.data.previous.period.end, fmt)})`,
    columns: [
      { header: "Section", value: (l) => l.section, width: 24 },
      { header: "Measure", value: (l) => l.metric, width: 48 },
      { header: "This week", value: (l) => l.value, width: 16 },
      { header: "Previous week", value: (l) => l.previous, width: 16 },
      { header: "Change", value: (l) => l.change, width: 14 },
      { header: "Note", value: (l) => l.note, width: 44 },
    ],
    rows: sections.flatMap((s) => s.metrics.map((mt) => ({ section: `${s.key}. ${s.title}`, metric: mt.label, value: mt.value, previous: mt.previous, change: mt.change, note: mt.note ?? "" }))),
  };
  const lists: ExportSheet<string[]>[] = sections.flatMap((s) =>
    s.tables.map((t) => ({
      name: `${s.key} ${t.title}`.replace(/[\\/?*[\]:]/g, " ").slice(0, 31),
      title: `${s.key}. ${t.title}`,
      columns: t.columns.map((c, i) => ({ header: c, value: (row: string[]) => row[i] ?? "", width: i === 1 ? 30 : 18 })),
      rows: t.rows.length ? t.rows : [[t.empty]],
    })),
  );
  await downloadWorkbook(`CESS-Weekly-Report-${r.data.period.start}.xlsx`, [summary, ...lists]);
}

/** PDF with the same content (jsPDF, loaded only when needed). Standard PDF fonts have no ₹ sign, so amounts use "Rs.". */
export async function downloadReportPdf(r: WeeklyReport, fmt: DateFormat, company: string): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const rs = (n: number) => `Rs. ${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;
  const sections = buildSections(r, fmt, rs);
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const ascii = (s: string) => s.replace(/₹/g, "Rs. ").replace(/[−–]/g, "-").replace(/—/g, "-").replace(/·/g, "-");
  const W = doc.internal.pageSize.getWidth();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(ascii(`${company || "CESS"} - Weekly management report`), 40, 48);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(
    ascii(`Week ${formatDate(r.data.period.start, fmt)} to ${formatDate(r.data.period.end, fmt)} - compared with ${formatDate(r.data.previous.period.start, fmt)} to ${formatDate(r.data.previous.period.end, fmt)}`),
    40,
    66,
  );
  doc.text(ascii(`Generated ${formatDateTimeIST(r.generated_at, fmt)} (${r.kind === "scheduled" ? "automatic" : `by ${r.generated_by_name ?? "user"}`}). From the recorded data only.`), 40, 80);
  let y = 100;
  for (const s of sections) {
    if (y > 740) {
      doc.addPage();
      y = 48;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(ascii(`${s.key}. ${s.title}`), 40, y);
    y += 6;
    if (s.note) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
      const lines = doc.splitTextToSize(ascii(s.note), W - 80);
      doc.text(lines, 40, y + 10);
      y += 10 * lines.length + 4;
    }
    if (s.metrics.length) {
      autoTable(doc, {
        startY: y + 4,
        head: [["Measure", "This week", "Previous week", "Change"]],
        body: s.metrics.map((mt) => [ascii(mt.note ? `${mt.label} (${mt.note})` : mt.label), ascii(mt.value), ascii(mt.previous), ascii(mt.change)]),
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [27, 58, 122] },
        columnStyles: { 0: { cellWidth: 260 } },
        margin: { left: 40, right: 40 },
      });
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10;
    }
    for (const t of s.tables) {
      if (y > 760) {
        doc.addPage();
        y = 48;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.text(ascii(t.title), 40, y + 8);
      autoTable(doc, {
        startY: y + 12,
        head: [t.columns.map(ascii)],
        body: t.rows.length ? t.rows.map((row) => row.map(ascii)) : [[ascii(t.empty), ...t.columns.slice(1).map(() => "")]],
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [71, 85, 105] },
        margin: { left: 40, right: 40 },
      });
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 12;
    }
    y += 6;
  }
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(100);
    doc.text(`Page ${i} of ${pages}`, W - 90, doc.internal.pageSize.getHeight() - 20);
  }
  doc.save(`CESS-Weekly-Report-${r.data.period.start}.pdf`);
}
