// Monitoring (delivery requirement 25): System Health reports the database scheduler, the reminder engine and the latest
// weekly report; old scheduler log rows are cleaned up; only users with system.view may see it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeSql, createAuthUser, enrollAndVerifyMfa, resetLocalDatabase, signIn, sql, uniqueEmail } from "../helpers/clients";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let admin: SupabaseClient;
let manager: SupabaseClient;

beforeAll(async () => {
  await resetLocalDatabase();
  const adminEmail = uniqueEmail("mon.admin");
  await createAuthUser(adminEmail, "Monitor Admin");
  await sql("select private.bootstrap_first_admin($1)", [adminEmail]);
  admin = await signIn(adminEmail);
  await enrollAndVerifyMfa(admin);
  const mEmail = uniqueEmail("mon.mgr");
  const id = await createAuthUser(mEmail, "Monitor Manager");
  await sql("update public.profiles set role_key = 'manager', is_active = true where id = $1", [id]);
  manager = await signIn(mEmail);
  await enrollAndVerifyMfa(manager);
}, 300_000);

afterAll(async () => {
  await closeSql();
});

describe("System Health monitoring", () => {
  it("lists every scheduled job with its last run, runs and failures", async () => {
    const { data, error } = await admin.rpc("system_health");
    expect(error).toBeNull();
    const jobs = (data as Json).scheduled_jobs as Json[];
    expect(jobs.map((j) => j.name)).toEqual(["cess-reminders", "cess-scheduler-log-cleanup", "cess-weekly-report"]);
    for (const j of jobs) expect(j).toMatchObject({ active: true, runs_7d: expect.any(Number), failures_7d: expect.any(Number) });
    expect(jobs.find((j) => j.name === "cess-scheduler-log-cleanup")!.schedule).toBe("17 21 * * *");
  });

  it("shows the reminder engine's last run and the latest weekly report", async () => {
    const before = (await admin.rpc("system_health")).data as Json;
    expect(before.reminder_engine).toMatchObject({ enabled: true, run_time_ist: "09:00", last_run_date: null });
    expect(before.last_weekly_report).toBeNull();
    await sql("select private.run_reminders(now(), true)");
    const d = new Date(Date.now() + 330 * 60_000);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
    expect((await admin.rpc("generate_weekly_report", { p_start: d.toISOString().slice(0, 10) })).error).toBeNull();
    const after = (await admin.rpc("system_health")).data as Json;
    expect(after.reminder_engine.last_run_date).toBe(after.today_ist);
    expect(after.last_weekly_report).toMatchObject({ period_start: d.toISOString().slice(0, 10), kind: "manual" });
  });

  it("a failed scheduler run is reported with its message", async () => {
    const job = (await sql<{ jobid: string }>("select jobid::text from cron.job where jobname = 'cess-weekly-report'"))[0]!.jobid;
    await sql(
      `insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
       values ($1::bigint, 900000001, 1, current_database(), 'postgres', 'select 1', 'failed', 'ERROR: test failure', now(), now())`,
      [job],
    );
    const jobs = ((await admin.rpc("system_health")).data as Json).scheduled_jobs as Json[];
    expect(jobs.find((j) => j.name === "cess-weekly-report")).toMatchObject({ last_status: "failed", last_message: "ERROR: test failure", failures_7d: 1 });
  });

  it("the daily clean-up removes scheduler log rows older than 30 days and keeps recent ones", async () => {
    const job = (await sql<{ jobid: string }>("select jobid::text from cron.job where jobname = 'cess-reminders'"))[0]!.jobid;
    await sql(
      `insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
       values ($1::bigint, 900000002, 1, current_database(), 'postgres', 'select 1', 'succeeded', '1 row', now() - interval '40 days', now() - interval '40 days'),
              ($1::bigint, 900000003, 1, current_database(), 'postgres', 'select 1', 'succeeded', '1 row', now() - interval '2 days', now() - interval '2 days')`,
      [job],
    );
    const command = (await sql<{ command: string }>("select command from cron.job where jobname = 'cess-scheduler-log-cleanup'"))[0]!.command;
    await sql(command); // exactly what the scheduler runs every night
    const left = await sql<{ runid: string }>("select runid::text from cron.job_run_details where runid in (900000002, 900000003) order by runid");
    expect(left.map((r) => r.runid)).toEqual(["900000003"]);
  });

  it("is only for users who may view system health (Admin by default)", async () => {
    expect((await manager.rpc("system_health")).error?.code).toBe("42501");
  });
});
