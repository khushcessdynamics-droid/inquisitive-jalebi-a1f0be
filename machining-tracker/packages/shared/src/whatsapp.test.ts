import { describe, expect, it } from "vitest";
import { reminderKind, reminderSchedule, renderTemplate, templateValues, whatsappDigits, whatsappLink, type WhatsAppContext } from "./whatsapp";

describe("WhatsApp numbers", () => {
  it("adds the country code to Indian mobile numbers written in any common way", () => {
    expect(whatsappDigits("+91", "98220 12345")).toBe("919822012345");
    expect(whatsappDigits("+91", "098220-12345")).toBe("919822012345");
    expect(whatsappDigits("+91", "+91 98220 12345")).toBe("919822012345");
    expect(whatsappDigits("+91", "919822012345")).toBe("919822012345");
    expect(whatsappDigits("+91", "0091 98220 12345")).toBe("919822012345");
    expect(whatsappDigits("+971", "50 123 4567")).toBe("971501234567");
  });
  it("refuses empty or impossible numbers", () => {
    expect(whatsappDigits("+91", "")).toBeNull();
    expect(whatsappDigits("+91", "12")).toBeNull();
    expect(whatsappDigits("+91", "1234567890123456789")).toBeNull();
  });
  it("builds a wa.me link with the encoded message", () => {
    expect(whatsappLink("919822012345", "Job JOB-2627-0001 & part 4711/A")).toBe("https://wa.me/919822012345?text=Job%20JOB-2627-0001%20%26%20part%204711%2FA");
  });
});

describe("message templates", () => {
  const ctx: WhatsAppContext = {
    vendor_name: "Shree Engineering", contact_person: null, company: "CESS", job_no: "JOB-2627-0007", part: "4711 / Drive Shaft",
    qty: 100, date_given: "2026-11-01", original_commitment: "2026-11-05", current_commitment: "2026-11-08", delay_days: 2,
    delay_days_original: 5, pending_qty: 40, returned_qty: 60, accepted_qty: 55, rejected_qty: 5, rework_qty: 0, payment: null,
  };
  it("fills the job facts (Example 2 dates) and falls back to the vendor name for the contact person", () => {
    const r = renderTemplate("Dear {contact_person}, job {job_no} ({part}) revised from {original_commitment} to {current_commitment}; {pending_qty} pcs pending, {delay_days} days late.", templateValues(ctx, "dd-MMM-yyyy"));
    expect(r.text).toBe("Dear Shree Engineering, job JOB-2627-0007 (4711 / Drive Shaft) revised from 05-Nov-2026 to 08-Nov-2026; 40 pcs pending, 2 days late.");
    expect(r.missing).toEqual([]);
  });
  it("never invents missing facts: they are marked for the user to fill in", () => {
    const r = renderTemplate("Paid {payment_amount}, balance {balance}. {foo}", templateValues(ctx, "dd-MMM-yyyy"));
    expect(r.text).toBe("Paid [missing: Payment amount], balance [missing: Balance after the payment]. {foo}");
    expect(r.missing).toEqual(["payment_amount", "balance"]);
    expect(r.unknown).toEqual(["foo"]);
  });
  it("formats payments in rupees (Example 5)", () => {
    const v = templateValues({ ...ctx, payment: { amount: 15000, paid_on: "2026-11-03", mode: "upi", reference: "UTR1", balance: 15000 } }, "dd-MMM-yyyy");
    expect(renderTemplate("{payment_amount} on {payment_date} by {payment_mode} ({payment_reference}); balance {balance}", v).text).toBe(
      "₹15,000.00 on 03-Nov-2026 by UPI (UTR1); balance ₹15,000.00",
    );
  });
});

describe("reminder schedule (same rule as the database)", () => {
  const s = { enabled: true, days_before: [3, 1], on_due_date: true, overdue_after_days: 1, repeat_daily_when_overdue: true };
  it("default: 3 and 1 day before, on the day, 1 day after, then every day", () => {
    expect(reminderSchedule("2026-11-10", s, "2026-11-05", 8)).toEqual([
      { date: "2026-11-07", kind: "upcoming" },
      { date: "2026-11-09", kind: "upcoming" },
      { date: "2026-11-10", kind: "due_today" },
      { date: "2026-11-11", kind: "overdue" },
      { date: "2026-11-12", kind: "overdue" },
      { date: "2026-11-13", kind: "overdue" },
    ]);
  });
  it("respects the settings", () => {
    expect(reminderKind(2, s)).toBeNull();
    expect(reminderKind(-2, { ...s, overdue_after_days: 2, repeat_daily_when_overdue: false })).toBe("overdue");
    expect(reminderKind(-3, { ...s, overdue_after_days: 2, repeat_daily_when_overdue: false })).toBeNull();
    expect(reminderKind(0, { ...s, on_due_date: false })).toBeNull();
    expect(reminderSchedule("2026-11-10", { ...s, enabled: false }, "2026-11-05", 8)).toEqual([]);
  });
});
