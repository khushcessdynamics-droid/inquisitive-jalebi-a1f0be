import { describe, expect, it } from "vitest";
import { APPROVED_RELIABILITY_WEIGHTS, sumWeights, validateSetting } from "./settings";

const reliability = {
  weights: { ...APPROVED_RELIABILITY_WEIGHTS },
  min_eligible_jobs: 5,
  min_factors: 3,
  delay_cap_days: 14,
  stability_revisions_cap: 2,
  labels: { excellent: 85, good: 70, average: 50 },
};

describe("reliability settings", () => {
  it("approved Option 1 weights add up to 100", () => {
    expect(APPROVED_RELIABILITY_WEIGHTS).toEqual({ on_time: 30, quality: 25, delay: 15, stability: 10, completion_time: 10, vendor_cancellation: 10 });
    expect(sumWeights(APPROVED_RELIABILITY_WEIGHTS)).toBe(100);
    expect(validateSetting("reliability", reliability).success).toBe(true);
  });
  it("rejects weights that do not total 100 (e.g. original 35% + new 10% factor = 105)", () => {
    const r = validateSetting("reliability", { ...reliability, weights: { ...reliability.weights, on_time: 35 } });
    expect(r.success).toBe(false);
  });
  it("handles decimal weights without floating-point errors", () => {
    expect(sumWeights({ on_time: 33.33, quality: 33.33, delay: 33.34, stability: 0, completion_time: 0, vendor_cancellation: 0 })).toBe(100);
  });
  it("rejects negative weights, unknown fields and wrong label order", () => {
    expect(validateSetting("reliability", { ...reliability, weights: { ...reliability.weights, on_time: -5, quality: 60 } }).success).toBe(false);
    expect(validateSetting("reliability", { ...reliability, extra: 1 }).success).toBe(false);
    expect(validateSetting("reliability", { ...reliability, labels: { excellent: 70, good: 85, average: 50 } }).success).toBe(false);
  });
});

describe("other settings", () => {
  it("company GSTIN must be empty or 15 characters", () => {
    const base = { name: "CESS", address: "", gstin: "", phone: "", email: "" };
    expect(validateSetting("company", base).success).toBe(true);
    expect(validateSetting("company", { ...base, gstin: "27ABCDE1234F1Z5" }).success).toBe(true);
    expect(validateSetting("company", { ...base, gstin: "27ABC" }).success).toBe(false);
    expect(validateSetting("company", { ...base, email: "not-an-email" }).success).toBe(false);
  });
  it("localization is fixed to INR, Asia/Kolkata and an April financial year", () => {
    const ok = { currency: "INR", timezone: "Asia/Kolkata", date_format: "dd-MMM-yyyy", fy_start_month: 4 };
    expect(validateSetting("localization", ok).success).toBe(true);
    expect(validateSetting("localization", { ...ok, currency: "USD" }).success).toBe(false);
    expect(validateSetting("localization", { ...ok, fy_start_month: 1 }).success).toBe(false);
  });
  it("security: idle timeout must be shorter than the maximum session", () => {
    expect(validateSetting("security", { idle_timeout_minutes: 30, max_session_hours: 12 }).success).toBe(true);
    expect(validateSetting("security", { idle_timeout_minutes: 240, max_session_hours: 1 }).success).toBe(false);
    expect(validateSetting("security", { idle_timeout_minutes: 2, max_session_hours: 12 }).success).toBe(false);
  });
  it("automatic WhatsApp and email report delivery stay off until providers are configured", () => {
    expect(
      validateSetting("reminders", { enabled: true, days_before: [3, 1], on_due_date: true, overdue_after_days: 1, repeat_daily_when_overdue: true, run_time_ist: "09:00", whatsapp_auto: true }).success,
    ).toBe(false);
    expect(validateSetting("weekly_report", { enabled: true, weekday: 1, run_time_ist: "08:00", email_delivery: true }).success).toBe(false);
  });
  it("attachments: free-plan 50 MB limit and blocked executable types", () => {
    expect(validateSetting("attachments", { max_file_mb: 50, allowed_extensions: ["pdf", "step"] }).success).toBe(true);
    expect(validateSetting("attachments", { max_file_mb: 51, allowed_extensions: ["pdf"] }).success).toBe(false);
    expect(validateSetting("attachments", { max_file_mb: 10, allowed_extensions: ["exe"] }).success).toBe(false);
  });
});
