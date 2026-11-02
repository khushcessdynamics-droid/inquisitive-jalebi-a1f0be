import { formatDate, formatINR, type DateFormat } from "@cess/shared";
import { Badge, cx } from "./ui";

const STATUS_TONE: Record<string, string> = {
  Draft: "bg-slate-100 text-slate-700 ring-slate-200",
  "Sent to Vendor": "bg-sky-50 text-sky-700 ring-sky-200",
  "In Progress": "bg-brand-50 text-brand-700 ring-brand-100",
  "Due Soon": "bg-amber-50 text-amber-800 ring-amber-200",
  "Due Today": "bg-orange-100 text-orange-800 ring-orange-300",
  Overdue: "bg-red-50 text-red-700 ring-red-200",
  "Commitment Date Missing": "bg-violet-50 text-violet-700 ring-violet-200",
  "Partially Returned": "bg-teal-50 text-teal-700 ring-teal-200",
  "Quality Inspection Pending": "bg-indigo-50 text-indigo-700 ring-indigo-200",
  Completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Cancelled: "bg-slate-100 text-slate-500 ring-slate-200 line-through",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cx("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", STATUS_TONE[status] ?? STATUS_TONE.Draft)}>
      {status}
    </span>
  );
}

export function Money({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-slate-400">—</span>;
  return <span className="whitespace-nowrap tabular-nums">{formatINR(value)}</span>;
}

export function DateText({ value, format, empty = "—" }: { value: string | null | undefined; format: DateFormat; empty?: string }) {
  if (!value) return <span className="text-slate-400">{empty}</span>;
  return <span className="whitespace-nowrap">{formatDate(value, format)}</span>;
}

/** "3 days left", "Due today", "5 days late" */
export function DueText({ remaining, delay }: { remaining: number | null; delay: number | null }) {
  if (remaining !== null && remaining > 0) return <span className="text-xs text-slate-500">{remaining} day{remaining === 1 ? "" : "s"} left</span>;
  if (remaining === 0) return <span className="text-xs font-medium text-orange-700">Due today</span>;
  if (delay !== null && delay > 0) return <span className="text-xs font-medium text-red-700">{delay} day{delay === 1 ? "" : "s"} late</span>;
  return null;
}

export function SourceBadge({ source }: { source: string }) {
  return source === "excel_import" ? <Badge tone="slate">Imported</Badge> : null;
}
