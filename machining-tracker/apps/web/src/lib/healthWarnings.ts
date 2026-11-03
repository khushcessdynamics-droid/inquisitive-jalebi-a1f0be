// What on the System Health page needs the Admin's attention. Pure function of the system_health() result so it is unit-tested.

export interface ScheduledJob {
  name: string;
  schedule: string;
  active: boolean;
  last_start: string | null;
  last_end: string | null;
  last_status: string | null;
  last_message: string | null;
  runs_7d: number;
  failures_7d: number;
}
export interface HealthFacts {
  checked_at: string;
  database_size_bytes: number;
  storage_size_bytes: number | null;
  last_verified_backup: { finished_at: string | null } | null;
  last_failed_backup: { started_at: string } | null;
  scheduled_jobs: ScheduledJob[] | null;
  reminder_engine: { enabled: boolean; run_time_ist: string | null; last_run_date: string | null } | null;
  today_ist: string;
}
export interface Warning {
  level: "critical" | "warning";
  text: string;
}

export const FREE_DB_BYTES = 500 * 1024 * 1024;
export const FREE_STORAGE_BYTES = 1024 * 1024 * 1024;

export const JOB_LABELS: Record<string, string> = {
  "cess-reminders": "Reminders (checked every 15 minutes)",
  "cess-weekly-report": "Weekly management report (checked every 15 minutes)",
  "cess-scheduler-log-cleanup": "Scheduler log clean-up (daily)",
};

const HOUR = 3_600_000;

/** Minutes since midnight IST for an ISO timestamp. */
function istMinutes(iso: string): number {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function healthWarnings(h: HealthFacts, limits = { db: FREE_DB_BYTES, storage: FREE_STORAGE_BYTES }): Warning[] {
  const out: Warning[] = [];
  const now = new Date(h.checked_at).getTime();

  // backups
  const ok = h.last_verified_backup?.finished_at ? new Date(h.last_verified_backup.finished_at).getTime() : null;
  if (ok === null) out.push({ level: "critical", text: "No verified backup has been recorded. Set up the backup tool on the backup PC." });
  else if (now - ok > 48 * HOUR) {
    out.push({ level: "critical", text: `The last verified backup is ${Math.floor((now - ok) / (24 * HOUR))} days old. Check that the backup PC is on and the daily task runs.` });
  }
  if (h.last_failed_backup && (ok === null || new Date(h.last_failed_backup.started_at).getTime() > ok)) {
    out.push({ level: "critical", text: "The most recent backup attempt failed (see Backups below)." });
  }

  // free-plan space
  const pct = (used: number | null, limit: number) => (used === null ? 0 : (used / limit) * 100);
  const db = pct(h.database_size_bytes, limits.db);
  const st = pct(h.storage_size_bytes, limits.storage);
  if (db >= 80) out.push({ level: db >= 95 ? "critical" : "warning", text: `The database uses ${db.toFixed(0)}% of the plan's space.` });
  if (st >= 80) out.push({ level: st >= 95 ? "critical" : "warning", text: `File storage uses ${st.toFixed(0)}% of the plan's space; new uploads will fail when it is full.` });

  // scheduler
  if (h.scheduled_jobs === null) out.push({ level: "critical", text: "The database scheduler is not available, so reminders and weekly reports do not run." });
  for (const j of h.scheduled_jobs ?? []) {
    const label = JOB_LABELS[j.name] ?? j.name;
    if (!j.active) out.push({ level: "critical", text: `${label} is switched off in the scheduler.` });
    else if (j.last_status === "failed") out.push({ level: "critical", text: `${label}: the last run failed.` });
    else if (j.failures_7d > 0) out.push({ level: "warning", text: `${label}: ${j.failures_7d} failed run(s) in the last 7 days.` });
    const everyQuarter = j.schedule.startsWith("*/15");
    const last = j.last_start ? new Date(j.last_start).getTime() : null;
    if (j.active && everyQuarter && (last === null || now - last > HOUR)) {
      out.push({ level: "critical", text: `${label} has not run for more than an hour.` });
    }
  }

  // today's reminders (after the configured time plus 30 minutes)
  const r = h.reminder_engine;
  if (r?.enabled && r.run_time_ist && r.last_run_date !== h.today_ist) {
    const [hh, mm] = r.run_time_ist.split(":").map(Number);
    if (istMinutes(h.checked_at) > (hh ?? 9) * 60 + (mm ?? 0) + 30) {
      out.push({ level: "warning", text: `Today's reminders have not run yet (due at ${r.run_time_ist} IST).` });
    }
  }
  return out;
}
