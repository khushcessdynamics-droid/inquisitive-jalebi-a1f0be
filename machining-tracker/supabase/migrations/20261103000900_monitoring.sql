-- Monitoring (delivery requirement 25)
--   * System Health also reports the database scheduler: every scheduled job with its last run, runs and failures in the last
--     7 days (failure messages are shown to Admins only, through system.view), the reminder engine's last run and the latest
--     weekly report, so a stopped or failing job is visible.
--   * The scheduler writes one log row per run (about 290 a day); rows older than 30 days are removed daily so the log does not
--     slowly fill the free plan's 500 MB.

create or replace function public.system_health()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tables jsonb; v_storage_bytes bigint := 0; v_storage_objects bigint := 0; v_schema text;
  v_last_ok jsonb; v_last_fail jsonb; v_jobs jsonb; v_reminders jsonb; v_report jsonb;
begin
  perform private.require_permission('system.view');
  select coalesce(jsonb_object_agg(relname, n_live_tup order by relname), '{}'::jsonb) into v_tables
    from pg_stat_user_tables where schemaname = 'public';
  begin
    select coalesce(sum((metadata ->> 'size')::bigint), 0), count(*) into v_storage_bytes, v_storage_objects
      from storage.objects;
  exception when others then
    v_storage_bytes := null; v_storage_objects := null;
  end;
  begin
    select max(version) into v_schema from supabase_migrations.schema_migrations;
  exception when others then
    v_schema := null;
  end;
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', j.jobname,
             'schedule', j.schedule,
             'active', j.active,
             'last_start', l.start_time,
             'last_end', l.end_time,
             'last_status', l.status,
             'last_message', case when l.status = 'failed' then left(l.return_message, 300) end,
             'runs_7d', coalesce(w.runs, 0),
             'failures_7d', coalesce(w.failures, 0)) order by j.jobname), '[]'::jsonb)
      into v_jobs
      from cron.job j
      left join lateral (select d.start_time, d.end_time, d.status, d.return_message from cron.job_run_details d
                          where d.jobid = j.jobid order by d.start_time desc limit 1) l on true
      left join lateral (select count(*)::int as runs, (count(*) filter (where d.status = 'failed'))::int as failures
                           from cron.job_run_details d where d.jobid = j.jobid and d.start_time > now() - interval '7 days') w on true;
  exception when others then
    v_jobs := null; -- scheduler not available
  end;
  select jsonb_build_object('enabled', coalesce((s.value ->> 'enabled')::boolean, true), 'run_time_ist', s.value ->> 'run_time_ist',
                            'last_run_date', r.run_date, 'last_run_at', r.last_run_at, 'reminders_created', r.reminders_created)
    into v_reminders
    from (select 1) one
    left join public.app_settings s on s.key = 'reminders'
    left join lateral (select * from public.reminder_runs order by run_date desc limit 1) r on true;
  select jsonb_build_object('period_start', w.period_start, 'period_end', w.period_end, 'kind', w.kind, 'generated_at', w.generated_at)
    into v_report
    from public.weekly_reports w order by w.generated_at desc limit 1;
  select to_jsonb(b) into v_last_ok from public.backup_runs b
   where b.status = 'verified' order by b.finished_at desc nulls last limit 1;
  select to_jsonb(b) into v_last_fail from public.backup_runs b
   where b.status = 'failed' order by b.started_at desc limit 1;
  return jsonb_build_object(
    'checked_at', now(),
    'today_ist', private.today_ist(),
    'database_ok', true,
    'database_size_bytes', pg_database_size(current_database()),
    'storage_size_bytes', v_storage_bytes,
    'storage_object_count', v_storage_objects,
    'auth_users', (select count(*) from auth.users),
    'active_users', (select count(*) from public.profiles where is_active),
    'live_sessions', (select count(*) from auth.sessions s where s.not_after is null or s.not_after > now()),
    'schema_version', v_schema,
    'table_rows', v_tables,
    'activity_log_rows', (select count(*) from public.activity_log),
    'last_verified_backup', v_last_ok,
    'last_failed_backup', v_last_fail,
    'scheduled_jobs', v_jobs,
    'reminder_engine', v_reminders,
    'last_weekly_report', v_report
  );
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'cess-scheduler-log-cleanup') then
    perform cron.unschedule('cess-scheduler-log-cleanup');
  end if;
  perform cron.schedule('cess-scheduler-log-cleanup', '17 21 * * *',
    $job$delete from cron.job_run_details where end_time < now() - interval '30 days'$job$);
end;
$$;
