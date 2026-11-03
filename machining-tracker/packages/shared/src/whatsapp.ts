// WhatsApp click-to-chat helpers and message templates (the database supplies the values; see docs/WHATSAPP_AND_REMINDERS.md).
import { daysBetween, formatDate } from "./dates";
import type { DateFormat } from "./settings";
import { formatINR } from "./format";

/**
 * Digits for https://wa.me/<digits>: country code + national number, no "+", spaces or leading zero.
 * "98220 12345" with "+91" -> "919822012345"; "+91 98220 12345" or "0091..." are recognised as already international.
 * Returns null when the result cannot be a valid number (8 to 15 digits).
 */
export function whatsappDigits(countryCode: string | null | undefined, number: string | null | undefined): string | null {
  const raw = (number ?? "").trim();
  if (!raw) return null;
  const cc = (countryCode ?? "+91").replace(/\D/g, "");
  let digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) {
    // already international
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else {
    digits = digits.replace(/^0+/, "");
    // a number that already carries the country code (e.g. 919822012345) is kept as it is
    if (!(cc && digits.startsWith(cc) && digits.length > 10)) digits = cc + digits;
  }
  return /^[0-9]{8,15}$/.test(digits) ? digits : null;
}

export function whatsappLink(digits: string, text: string): string {
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export const TEMPLATE_PLACEHOLDERS: Record<string, string> = {
  vendor_name: "Vendor name",
  contact_person: "Vendor contact person (vendor name if empty)",
  company: "Your company name (Settings > Company)",
  job_no: "Job ID",
  part: "Part No / Part Name",
  qty: "Quantity sent",
  date_given: "Date given to the vendor",
  original_commitment: "Original committed date",
  current_commitment: "Current (latest) committed date",
  delay_days: "Days late against the current committed date",
  delay_days_original: "Days late against the original committed date",
  pending_qty: "Pieces still with the vendor",
  returned_qty: "Pieces returned",
  accepted_qty: "Pieces accepted",
  rejected_qty: "Pieces rejected",
  rework_qty: "Pieces sent back for rework",
  payment_amount: "Payment amount",
  payment_date: "Payment date",
  payment_mode: "Payment mode",
  payment_reference: "Payment reference",
  balance: "Balance after the payment",
};

const MODES: Record<string, string> = { bank_transfer: "bank transfer", upi: "UPI", cheque: "cheque", cash: "cash", other: "other" };

export interface WhatsAppContext {
  vendor_name: string;
  contact_person: string | null;
  company: string | null;
  job_no: string;
  part: string;
  qty: number | null;
  date_given: string | null;
  original_commitment: string | null;
  current_commitment: string | null;
  delay_days: number | null;
  delay_days_original: number | null;
  pending_qty: number | null;
  returned_qty: number | null;
  accepted_qty: number | null;
  rejected_qty: number | null;
  rework_qty: number | null;
  payment?: { amount: number; paid_on: string; mode: string; reference: string | null; balance: number | null } | null;
}

/** Placeholder values as text. Missing facts stay missing (never invented): the message shows them for editing. */
export function templateValues(c: WhatsAppContext, fmt: DateFormat): Record<string, string | null> {
  const num = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));
  const date = (v: string | null | undefined) => (v ? formatDate(v, fmt) : null);
  return {
    vendor_name: c.vendor_name,
    contact_person: c.contact_person || c.vendor_name,
    company: c.company,
    job_no: c.job_no,
    part: c.part,
    qty: num(c.qty),
    date_given: date(c.date_given),
    original_commitment: date(c.original_commitment),
    current_commitment: date(c.current_commitment),
    delay_days: num(c.delay_days),
    delay_days_original: num(c.delay_days_original),
    pending_qty: num(c.pending_qty),
    returned_qty: num(c.returned_qty),
    accepted_qty: num(c.accepted_qty),
    rejected_qty: num(c.rejected_qty),
    rework_qty: num(c.rework_qty),
    payment_amount: c.payment ? formatINR(c.payment.amount) : null,
    payment_date: c.payment ? date(c.payment.paid_on) : null,
    payment_mode: c.payment ? (MODES[c.payment.mode] ?? c.payment.mode) : null,
    payment_reference: c.payment ? (c.payment.reference ?? "-") : null,
    balance: c.payment && c.payment.balance !== null ? formatINR(c.payment.balance) : null,
  };
}

/**
 * Replaces {placeholders}. Unknown placeholders and missing values are left in the text as [missing: name]
 * and listed, so nobody sends a message with invented facts.
 */
export function renderTemplate(body: string, values: Record<string, string | null>): { text: string; missing: string[]; unknown: string[] } {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const text = body.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    if (!(key in TEMPLATE_PLACEHOLDERS)) {
      unknown.add(key);
      return `{${key}}`;
    }
    const v = values[key];
    if (v === null || v === undefined || v === "") {
      missing.add(key);
      return `[missing: ${TEMPLATE_PLACEHOLDERS[key]}]`;
    }
    return v;
  });
  return { text, missing: [...missing], unknown: [...unknown] };
}

export interface ReminderSettings {
  enabled: boolean;
  days_before: number[];
  on_due_date: boolean;
  overdue_after_days: number;
  repeat_daily_when_overdue: boolean;
}
export type ReminderKind = "upcoming" | "due_today" | "overdue";

/** Same rule as private.reminder_kind() in the database. */
export function reminderKind(daysToDue: number, s: ReminderSettings): ReminderKind | null {
  if (daysToDue > 0 && s.days_before.includes(daysToDue)) return "upcoming";
  if (daysToDue === 0 && s.on_due_date) return "due_today";
  if (daysToDue < 0 && (-daysToDue === s.overdue_after_days || (s.repeat_daily_when_overdue && -daysToDue > s.overdue_after_days))) return "overdue";
  return null;
}

/** Reminder days for a committed date, from `from` for `days` days (Settings preview). */
export function reminderSchedule(due: string, s: ReminderSettings, from: string, days: number): Array<{ date: string; kind: ReminderKind }> {
  if (!s.enabled) return [];
  const out: Array<{ date: string; kind: ReminderKind }> = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i <= days; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const kind = reminderKind(daysBetween(date, due), s);
    if (kind) out.push({ date, kind });
  }
  return out;
}
