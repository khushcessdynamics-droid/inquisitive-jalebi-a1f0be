const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const num = new Intl.NumberFormat("en-IN");

/** ₹12,50,000.00 (Indian digit grouping). Empty for null. */
export function formatINR(value: number | string | null | undefined, whole = false): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "";
  return (whole ? inrWhole : inr).format(n);
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : num.format(value);
}

/** All job statuses in display order (calculated by the database). */
export const JOB_STATUSES = [
  "Draft",
  "Sent to Vendor",
  "In Progress",
  "Due Soon",
  "Due Today",
  "Overdue",
  "Commitment Date Missing",
  "Partially Returned",
  "Quality Inspection Pending",
  "Completed",
  "Cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
