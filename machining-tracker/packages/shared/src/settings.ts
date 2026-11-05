// Zod schemas for every settings document. They mirror private.validate_setting() in the database,
// which remains the authority: the browser validates for fast feedback, the database enforces.
import { z } from "zod";

const wholeNumber = (min: number, max: number, label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`);

const timeHHMM = (label: string) =>
  z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, `${label} must be HH:MM (24-hour)`);

export const companySettingsSchema = z
  .object({
    name: z.string().max(120),
    address: z.string().max(500),
    gstin: z
      .string()
      .max(15)
      .regex(/^$|^[0-9]{2}[A-Z0-9]{13}$/, "GSTIN must be 15 characters (2 digits + 13 capital letters/digits) or empty"),
    phone: z.string().max(30),
    email: z.string().max(120).regex(/^$|^[^@\s]+@[^@\s]+\.[^@\s]+$/, "Email address is not valid"),
  })
  .strict();

export const DATE_FORMATS = ["dd-MMM-yyyy", "dd/MM/yyyy", "dd-MM-yyyy", "yyyy-MM-dd"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const localizationSettingsSchema = z
  .object({
    currency: z.literal("INR"),
    timezone: z.literal("Asia/Kolkata"),
    date_format: z.enum(DATE_FORMATS),
    fy_start_month: z.literal(4),
  })
  .strict();

export const securitySettingsSchema = z
  .object({
    idle_timeout_minutes: wholeNumber(5, 240, "Idle timeout (minutes)"),
    max_session_hours: wholeNumber(1, 72, "Maximum session length (hours)"),
  })
  .strict()
  .refine((v) => v.max_session_hours * 60 >= v.idle_timeout_minutes, {
    message: "Maximum session length must be longer than the idle timeout",
    path: ["max_session_hours"],
  });

export const jobsSettingsSchema = z
  .object({
    due_soon_days: wholeNumber(1, 30, "Due soon (days)"),
    long_pending_days: wholeNumber(1, 365, "Long pending alert (days)"),
  })
  .strict();

export const RELIABILITY_FACTORS = [
  "on_time",
  "quality",
  "delay",
  "stability",
  "completion_time",
  "vendor_cancellation",
] as const;
export type ReliabilityFactor = (typeof RELIABILITY_FACTORS)[number];

export const RELIABILITY_FACTOR_LABELS: Record<ReliabilityFactor, string> = {
  on_time: "On-time delivery",
  quality: "Quality performance",
  delay: "Delay performance",
  stability: "Commitment stability",
  completion_time: "Completion time",
  vendor_cancellation: "Vendor-caused cancellation",
};

const weight = z.number().min(0, "Weight cannot be negative").max(100, "Weight cannot exceed 100");

export const reliabilitySettingsSchema = z
  .object({
    weights: z
      .object({
        on_time: weight,
        quality: weight,
        delay: weight,
        stability: weight,
        completion_time: weight,
        vendor_cancellation: weight,
      })
      .strict(),
    min_eligible_jobs: wholeNumber(1, 100, "Minimum eligible jobs"),
    min_factors: wholeNumber(1, 6, "Minimum factors with data"),
    delay_cap_days: wholeNumber(1, 365, "Delay cap (days)"),
    stability_revisions_cap: wholeNumber(1, 10, "Revisions cap"),
    labels: z
      .object({
        excellent: wholeNumber(1, 100, "Excellent threshold"),
        good: wholeNumber(1, 100, "Good threshold"),
        average: wholeNumber(0, 100, "Average threshold"),
      })
      .strict(),
  })
  .strict()
  .refine((v) => sumWeights(v.weights) === 100, {
    message: "Reliability weights must add up to exactly 100",
    path: ["weights"],
  })
  .refine((v) => v.labels.excellent > v.labels.good && v.labels.good > v.labels.average, {
    message: "Score thresholds must be Excellent > Good > Average",
    path: ["labels"],
  });

/** Sum with 2-decimal rounding so 33.33 + 33.33 + 33.34 counts as 100. */
export function sumWeights(weights: Record<ReliabilityFactor, number>): number {
  const total = RELIABILITY_FACTORS.reduce((acc, f) => acc + Math.round(weights[f] * 100), 0);
  return total / 100;
}

/** Approved Option 1 weights (On-time 30, Quality 25, Delay 15, Stability 10, Completion 10, Cancellation 10). */
export const APPROVED_RELIABILITY_WEIGHTS: Record<ReliabilityFactor, number> = {
  on_time: 30,
  quality: 25,
  delay: 15,
  stability: 10,
  completion_time: 10,
  vendor_cancellation: 10,
};

/** Weights for the cost-comparison recommendation. Quality enters through the reliability score (25% of it). */
export const COST_COMPARISON_FACTORS = ["price", "reliability", "delivery"] as const;
export type CostComparisonFactor = (typeof COST_COMPARISON_FACTORS)[number];
export const COST_COMPARISON_FACTOR_LABELS: Record<CostComparisonFactor, string> = {
  price: "Price (total for the required quantity)",
  reliability: "Vendor reliability score",
  delivery: "Expected delivery days",
};
export const DEFAULT_COST_COMPARISON_WEIGHTS: Record<CostComparisonFactor, number> = { price: 45, reliability: 35, delivery: 20 };

export const costComparisonSettingsSchema = z
  .object({
    weights: z
      .object({ price: weight, reliability: weight, delivery: weight })
      .strict(),
    min_quotes: wholeNumber(2, 10, "Minimum quotations to recommend"),
    stale_quote_days: wholeNumber(7, 730, "Quotation age warning (days)"),
  })
  .strict()
  .refine((v) => Math.round((v.weights.price + v.weights.reliability + v.weights.delivery) * 100) === 10000, {
    message: "Recommendation weights must add up to exactly 100",
    path: ["weights"],
  })
  .refine((v) => v.weights.price < 100, {
    message: "Price cannot carry 100%: the recommendation must not be based on price alone",
    path: ["weights", "price"],
  });

export const remindersSettingsSchema = z
  .object({
    enabled: z.boolean(),
    days_before: z.array(wholeNumber(1, 30, "Days before")).max(5),
    on_due_date: z.boolean(),
    overdue_after_days: wholeNumber(1, 30, "First overdue reminder (days)"),
    repeat_daily_when_overdue: z.boolean(),
    run_time_ist: timeHHMM("Reminder time"),
    whatsapp_auto: z.literal(false),
  })
  .strict();

export const weeklyReportSettingsSchema = z
  .object({
    enabled: z.boolean(),
    weekday: wholeNumber(1, 7, "Report weekday (1 = Monday)"),
    run_time_ist: timeHHMM("Report time"),
    email_delivery: z.literal(false),
  })
  .strict();

const BLOCKED_EXTENSIONS = ["exe", "bat", "cmd", "com", "msi", "js", "vbs", "ps1", "scr", "html", "htm", "svg"];
export const attachmentsSettingsSchema = z
  .object({
    max_file_mb: wholeNumber(1, 50, "Maximum file size (MB)"),
    allowed_extensions: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9]{1,10}$/, "Extensions must be lower-case letters/digits without a dot")
          .refine((e) => !BLOCKED_EXTENSIONS.includes(e), "This extension is not allowed for security reasons"),
      )
      .min(1),
  })
  .strict();

export const whatsappSettingsSchema = z
  .object({
    default_country_code: z.string().regex(/^\+[0-9]{1,4}$/, "Country code must look like +91"),
    mode: z.literal("click_to_chat"),
  })
  .strict();

export const settingsSchemas = {
  company: companySettingsSchema,
  localization: localizationSettingsSchema,
  security: securitySettingsSchema,
  jobs: jobsSettingsSchema,
  reliability: reliabilitySettingsSchema,
  cost_comparison: costComparisonSettingsSchema,
  reminders: remindersSettingsSchema,
  weekly_report: weeklyReportSettingsSchema,
  attachments: attachmentsSettingsSchema,
  whatsapp: whatsappSettingsSchema,
} as const;

export type SettingKey = keyof typeof settingsSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingsSchemas)[K]>;

export function validateSetting<K extends SettingKey>(key: K, value: unknown) {
  return settingsSchemas[key].safeParse(value);
}
