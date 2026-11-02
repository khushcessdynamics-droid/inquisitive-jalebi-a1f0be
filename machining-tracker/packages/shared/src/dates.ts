// Date helpers. Business dates are calendar dates in India (Asia/Kolkata), stored as YYYY-MM-DD.
import type { DateFormat } from "./settings";

const IST_OFFSET_MINUTES = 330; // India has no daylight saving time
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today's calendar date in India as YYYY-MM-DD. `now` is injectable for tests. */
export function todayIST(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new Error(`Invalid date: ${from} / ${to}`);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Indian financial year (April-March) label for a date, e.g. 2026-11-02 -> "2026-27". */
export function financialYear(date: string): { label: string; start: string; end: string } {
  if (!isIsoDate(date)) throw new Error(`Invalid date: ${date}`);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return {
    label: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}

/** Format a YYYY-MM-DD date with the configured format. Returns "" for empty input. */
export function formatDate(date: string | null | undefined, format: DateFormat = "dd-MMM-yyyy"): string {
  if (!date) return "";
  const iso = date.slice(0, 10);
  if (!isIsoDate(iso)) return date;
  const [y, m, d] = iso.split("-");
  switch (format) {
    case "dd-MMM-yyyy":
      return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
    case "dd/MM/yyyy":
      return `${d}/${m}/${y}`;
    case "dd-MM-yyyy":
      return `${d}-${m}-${y}`;
    case "yyyy-MM-dd":
      return iso;
  }
}

/** Format a timestamp (ISO string) as date + time in India. */
export function formatDateTimeIST(timestamp: string | null | undefined, format: DateFormat = "dd-MMM-yyyy"): string {
  if (!timestamp) return "";
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return timestamp;
  const shifted = new Date(t + IST_OFFSET_MINUTES * 60_000).toISOString();
  return `${formatDate(shifted.slice(0, 10), format)} ${shifted.slice(11, 16)} IST`;
}
