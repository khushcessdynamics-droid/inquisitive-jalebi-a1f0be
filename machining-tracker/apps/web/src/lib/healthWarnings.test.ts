import { describe, expect, it } from "vitest";
import { FREE_DB_BYTES, FREE_STORAGE_BYTES, healthWarnings, type HealthFacts, type ScheduledJob } from "./healthWarnings";

const NOW = "2026-11-03T06:00:00Z"; // 11:30 IST
const job = (name: string, over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  name, schedule: "*/15 * * * *", active: true, last_start: "2026-11-03T05:45:00Z", last_end: "2026-11-03T05:45:01Z",
  last_status: "succeeded", last_message: null, runs_7d: 600, failures_7d: 0, ...over,
});
const healthy: HealthFacts = {
  checked_at: NOW,
  today_ist: "2026-11-03",
  database_size_bytes: 40 * 1024 * 1024,
  storage_size_bytes: 100 * 1024 * 1024,
  last_verified_backup: { finished_at: "2026-11-02T15:40:00Z" },
  last_failed_backup: null,
  scheduled_jobs: [job("cess-reminders"), job("cess-weekly-report"), job("cess-scheduler-log-cleanup", { schedule: "17 21 * * *", last_start: "2026-11-02T21:17:00Z" })],
  reminder_engine: { enabled: true, run_time_ist: "09:00", last_run_date: "2026-11-03" },
};

describe("System Health warnings", () => {
  it("a healthy system has no warnings", () => {
    expect(healthWarnings(healthy)).toEqual([]);
  });

  it("backups: none, too old, or the latest attempt failed", () => {
    expect(healthWarnings({ ...healthy, last_verified_backup: null })[0]).toMatchObject({ level: "critical", text: expect.stringMatching(/No verified backup/) });
    expect(healthWarnings({ ...healthy, last_verified_backup: { finished_at: "2026-10-30T15:40:00Z" } })[0]!.text).toMatch(/3 days old/);
    expect(healthWarnings({ ...healthy, last_failed_backup: { started_at: "2026-11-03T05:00:00Z" } })[0]!.text).toMatch(/most recent backup attempt failed/);
    // an older failure followed by a verified backup is fine
    expect(healthWarnings({ ...healthy, last_failed_backup: { started_at: "2026-11-01T15:30:00Z" } })).toEqual([]);
  });

  it("space: warning from 80 %, critical from 95 %", () => {
    expect(healthWarnings({ ...healthy, database_size_bytes: FREE_DB_BYTES * 0.85 })).toEqual([{ level: "warning", text: "The database uses 85% of the plan's space." }]);
    expect(healthWarnings({ ...healthy, storage_size_bytes: FREE_STORAGE_BYTES * 0.97 })[0]!.level).toBe("critical");
  });

  it("scheduler: unavailable, switched off, failing, or stalled", () => {
    expect(healthWarnings({ ...healthy, scheduled_jobs: null })[0]!.text).toMatch(/scheduler is not available/);
    const jobs = (j: ScheduledJob) => ({ ...healthy, scheduled_jobs: [j] });
    expect(healthWarnings(jobs(job("cess-reminders", { active: false })))[0]!.text).toMatch(/Reminders .* is switched off/);
    expect(healthWarnings(jobs(job("cess-reminders", { last_status: "failed" })))[0]!.text).toMatch(/last run failed/);
    expect(healthWarnings(jobs(job("cess-weekly-report", { failures_7d: 2 })))).toEqual([
      { level: "warning", text: "Weekly management report (checked every 15 minutes): 2 failed run(s) in the last 7 days." },
    ]);
    expect(healthWarnings(jobs(job("cess-reminders", { last_start: "2026-11-03T04:30:00Z" })))[0]!.text).toMatch(/has not run for more than an hour/);
    // the daily clean-up is not expected every 15 minutes
    expect(healthWarnings(jobs(job("cess-scheduler-log-cleanup", { schedule: "17 21 * * *", last_start: "2026-11-02T21:17:00Z" })))).toEqual([]);
  });

  it("reminders: warns only after the configured time plus 30 minutes, and only when switched on", () => {
    const notYet = { ...healthy, reminder_engine: { enabled: true, run_time_ist: "09:00", last_run_date: "2026-11-02" } };
    expect(healthWarnings(notYet)).toEqual([{ level: "warning", text: "Today's reminders have not run yet (due at 09:00 IST)." }]);
    expect(healthWarnings({ ...notYet, checked_at: "2026-11-03T03:45:00Z" })).toEqual([]); // 09:15 IST
    expect(healthWarnings({ ...notYet, reminder_engine: { ...notYet.reminder_engine, enabled: false } })).toEqual([]);
  });
});
