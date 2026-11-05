-- =====================================================================================
-- Phase 8: dashboard data and the weekly management report. Rules: docs/DASHBOARD_AND_REPORTS.md.
-- Every figure is calculated from the recorded data; a figure that cannot be calculated is returned empty (null),
-- never as zero.
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 1. Job register: add the start date of the job (columns appended; nothing else changes)
-- ---------------------------------------------------------------------------
create or replace view public.job_register with (security_invoker = true) as
select
  j.id, j.job_no, j.part_label, j.description, j.qty_sent, j.remarks, j.source, j.version,
  j.category_id, c.name as category_name,
  j.given_by_id, g.name as given_by_name,
  j.assigned_staff_id, private.user_name(j.assigned_staff_id) as assigned_staff_name,
  j.created_by, private.user_name(j.created_by) as created_by_name, j.created_at,
  j.closed_at, j.closed_on, j.closed_reason, j.archived_at,
  cur.id as assignment_id, cur.sequence_no, cur.version as assignment_version, cur.state as assignment_state,
  cur.vendor_id, v.name as vendor_name,
  cur.dispatched_on as date_given, cur.qty_sent as assignment_qty, cur.amount,
  cur.original_commitment_date, cur.current_commitment_date,
  coalesce(j.closed_on, cur.completed_on) as return_date,
  cur.cancelled_on,
  (select count(*)::int from public.job_assignments x where x.job_id = j.id) as assignment_count,
  st.status,
  case when cur.id is null then null
       else coalesce(j.closed_on, case cur.state when 'open' then cfg.today when 'completed' then cur.completed_on else cur.cancelled_on end) - cur.dispatched_on
  end as days_since_given,
  case when cur.state = 'open' and j.closed_at is null and cur.current_commitment_date is not null
       then cur.current_commitment_date - cfg.today end as remaining_days,
  case when cur.original_commitment_date is not null and cur.state <> 'cancelled'
       then greatest(0, coalesce(j.closed_on, cur.completed_on, cfg.today) - cur.original_commitment_date) end as delay_days,
  case when cur.current_commitment_date is not null and cur.state <> 'cancelled'
       then greatest(0, coalesce(j.closed_on, cur.completed_on, cfg.today) - cur.current_commitment_date) end as delay_days_current,
  (cur.state = 'open' and j.closed_at is null and cfg.today - cur.dispatched_on > cfg.long_days) as long_pending,
  private.fy_label(cur.dispatched_on) as financial_year,
  (select count(*)::int from public.commitment_revisions r where r.assignment_id = cur.id) as revision_count,
  qty.received as qty_received, qty.accepted as qty_accepted, qty.rejected as qty_rejected, qty.rework as qty_rework,
  qty.awaiting as qty_awaiting_inspection, qty.with_vendor as qty_with_vendor,
  -- the day the job started: given to the first vendor (or entered, for drafts); used for "new jobs" counts
  coalesce((select min(x.dispatched_on) from public.job_assignments x where x.job_id = j.id),
           (j.created_at at time zone 'Asia/Kolkata')::date) as start_date
from public.jobs j
join public.work_categories c on c.id = j.category_id
left join public.given_by_names g on g.id = j.given_by_id
left join lateral (
  select a.* from public.job_assignments a where a.job_id = j.id
  order by (a.state = 'open') desc, a.sequence_no desc limit 1
) cur on true
left join public.vendors v on v.id = cur.vendor_id
left join lateral private.assignment_quantities(cur.id) qty on true
cross join lateral (
  select private.today_ist() as today,
         private.setting_int('jobs', 'due_soon_days', 3) as due_soon,
         private.setting_int('jobs', 'long_pending_days', 10) as long_days
) cfg
cross join lateral (
  select private.job_status_full(j.closed_at is not null, cur.id is not null,
                                 case when cur.state = 'open' then cur.dispatched_on end,
                                 case when cur.state = 'open' then cur.current_commitment_date end,
                                 cfg.today, cfg.due_soon,
                                 case when cur.state = 'open' then qty.received end,
                                 case when cur.state = 'open' then qty.awaiting end,
                                 case when cur.state = 'open' then qty.with_vendor end) as status
) st;


-- ---------------------------------------------------------------------------
-- 2. Dashboard (SECURITY INVOKER: every number respects what the caller may see; money only with payments.view)
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_data(p_fy text default null)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_today date := private.today_ist();
  v_fy text := coalesce(nullif(trim(coalesce(p_fy, '')), ''), private.fy_label(private.today_ist()));
  v_from date;
  v_to date;
  v_month date := date_trunc('month', private.today_ist())::date;
  v_pay boolean := private.has_permission('payments.view');
  v_relp boolean := private.has_permission('reliability.view');
  v_rel jsonb := '[]'::jsonb;
  v_out jsonb;
begin
  perform private.require_permission('reports.view');
  if v_fy !~ '^\d{4}-\d{2}$' or right(v_fy, 2)::int <> (left(v_fy, 4)::int + 1) % 100 then
    raise exception 'Financial year must look like 2026-27.' using errcode = '22023';
  end if;
  v_from := make_date(left(v_fy, 4)::int, 4, 1);
  v_to := make_date(left(v_fy, 4)::int + 1, 3, 31);
  if v_relp then
    v_rel := coalesce((public.vendor_reliability(jsonb_build_object('fy', v_fy))) -> 'rows', '[]'::jsonb);
  end if;

  with reg as (select * from public.job_register where archived_at is null),
  insp as (
    select q.inspected_on, q.qty_accepted, q.qty_rejected, q.qty_rework
      from public.quality_inspections q
      join public.material_returns m on m.id = q.return_id and m.voided_at is null
     where q.voided_at is null
  ),
  months as (
    select g::date as m0, (g + interval '1 month')::date as m1
      from generate_series(v_from::timestamp, v_to::timestamp, interval '1 month') g
  )
  select jsonb_build_object(
    'fy', v_fy, 'from', v_from, 'to', v_to, 'today', v_today, 'month_start', v_month,
    'can_payments', v_pay, 'can_reliability', v_relp,
    'kpis', (select jsonb_build_object(
        'active', count(*) filter (where status not in ('Draft', 'Completed', 'Cancelled')),
        'pending', count(*) filter (where status not in ('Completed', 'Cancelled')),
        'drafts', count(*) filter (where status = 'Draft'),
        'overdue', count(*) filter (where status = 'Overdue'),
        'due_today', count(*) filter (where status = 'Due Today'),
        'inspection_pending', count(*) filter (where status = 'Quality Inspection Pending'),
        'partially_returned', count(*) filter (where status = 'Partially Returned'),
        'new_this_month', count(*) filter (where start_date between v_month and v_today),
        'new_fy', count(*) filter (where start_date between v_from and v_to),
        'completed_this_month', count(*) filter (where closed_on between v_month and v_today),
        'completed_fy', count(*) filter (where closed_on between v_from and v_to)) from reg),
    'money', case when v_pay then jsonb_build_object(
        'spending_fy', coalesce((select sum(p.amount) from public.vendor_payments p where p.paid_on between v_from and v_to), 0),
        'spending_month', coalesce((select sum(p.amount) from public.vendor_payments p where p.paid_on between v_month and v_today), 0),
        'outstanding', coalesce((select sum(a.balance) from public.payment_accounts a where a.balance > 0), 0),
        'outstanding_accounts', (select count(*) from public.payment_accounts a where a.balance > 0)) end,
    'reliability', case when v_relp then jsonb_build_object(
        'average', (select round(avg((x ->> 'score')::numeric), 1) from jsonb_array_elements(v_rel) x where x ->> 'score' is not null),
        'scored_vendors', (select count(*) from jsonb_array_elements(v_rel) x where x ->> 'score' is not null),
        'vendors', jsonb_array_length(v_rel),
        'ranking', coalesce((select jsonb_agg(jsonb_build_object('vendor_id', x ->> 'vendor_id', 'vendor_name', x ->> 'vendor_name',
                                  'score', (x ->> 'score')::numeric, 'label', x ->> 'label', 'eligible_jobs', (x ->> 'eligible_jobs')::int)
                                  order by (x ->> 'score')::numeric desc)
                               from jsonb_array_elements(v_rel) x where x ->> 'score' is not null), '[]'::jsonb)) end,
    'quality', (select jsonb_build_object(
        'inspected', coalesce(sum(qty_accepted + qty_rejected + qty_rework), 0),
        'accepted', coalesce(sum(qty_accepted), 0), 'rejected', coalesce(sum(qty_rejected), 0), 'rework', coalesce(sum(qty_rework), 0),
        'acceptance_pct', case when sum(qty_accepted + qty_rejected + qty_rework) > 0
                               then round(100.0 * sum(qty_accepted) / sum(qty_accepted + qty_rejected + qty_rework), 1) end)
        from insp where inspected_on between v_from and v_to),
    'monthly', (select jsonb_agg(jsonb_build_object(
        'month', to_char(mm.m0, 'YYYY-MM'),
        'started', (select count(*) from reg where start_date >= mm.m0 and start_date < mm.m1),
        'completed', (select count(*) from reg where closed_on >= mm.m0 and closed_on < mm.m1),
        'spending', case when v_pay then coalesce((select sum(p.amount) from public.vendor_payments p where p.paid_on >= mm.m0 and p.paid_on < mm.m1), 0) end,
        'inspected', (select coalesce(sum(qty_accepted + qty_rejected + qty_rework), 0) from insp where inspected_on >= mm.m0 and inspected_on < mm.m1),
        'rejected_or_rework', (select coalesce(sum(qty_rejected + qty_rework), 0) from insp where inspected_on >= mm.m0 and inspected_on < mm.m1),
        'future', mm.m0 > v_today) order by mm.m0) from months mm),
    'vendors', coalesce((select jsonb_agg(jsonb_build_object('vendor_id', z.vendor_id, 'vendor_name', z.name, 'jobs', z.n) order by z.n desc, z.name)
        from (select a.vendor_id, v.name, count(*) as n
                from public.job_assignments a
                join public.jobs j on j.id = a.job_id and j.archived_at is null
                join public.vendors v on v.id = a.vendor_id
               where a.dispatched_on between v_from and v_to
               group by a.vendor_id, v.name) z), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('category_id', z.category_id, 'category_name', z.category_name, 'jobs', z.n) order by z.n desc, z.category_name)
        from (select category_id, category_name, count(*) as n from reg where start_date between v_from and v_to group by 1, 2) z), '[]'::jsonb),
    'completion_split', (select jsonb_build_object(
        'completed', count(*) filter (where status = 'Completed'),
        'pending', count(*) filter (where status not in ('Completed', 'Cancelled')),
        'cancelled', count(*) filter (where status = 'Cancelled')) from reg where start_date between v_from and v_to),
    'on_time', (select jsonb_build_object(
        'on_time', count(*) filter (where a.original_commitment_date is not null and a.completed_on <= a.original_commitment_date),
        'late', count(*) filter (where a.original_commitment_date is not null and a.completed_on > a.original_commitment_date),
        'no_commitment', count(*) filter (where a.original_commitment_date is null))
        from public.job_assignments a join public.jobs j on j.id = a.job_id and j.archived_at is null
       where a.state = 'completed' and a.completed_on between v_from and v_to),
    'tables', jsonb_build_object(
      'overdue', coalesce((select jsonb_agg(to_jsonb(z)) from (
          select id, job_no, part_label, vendor_id, vendor_name, current_commitment_date, delay_days_current, qty_with_vendor
            from reg where status = 'Overdue' order by delay_days_current desc nulls last, job_no limit 10) z), '[]'::jsonb),
      'upcoming', coalesce((select jsonb_agg(to_jsonb(z)) from (
          select id, job_no, part_label, vendor_name, current_commitment_date, remaining_days, status, qty_with_vendor
            from reg where status in ('Due Today', 'Due Soon', 'In Progress', 'Sent to Vendor', 'Partially Returned')
             and current_commitment_date between v_today and v_today + 7
           order by current_commitment_date, job_no limit 10) z), '[]'::jsonb),
      'recent_added', coalesce((select jsonb_agg(to_jsonb(z)) from (
          select id, job_no, part_label, vendor_name, status, created_at, created_by_name from reg order by created_at desc limit 8) z), '[]'::jsonb),
      'recent_completed', coalesce((select jsonb_agg(to_jsonb(z)) from (
          select id, job_no, part_label, vendor_name, closed_on, closed_reason, qty_accepted, qty_rejected
            from reg where closed_at is not null order by closed_at desc limit 8) z), '[]'::jsonb),
      'pending_inspections', coalesce((select jsonb_agg(to_jsonb(z)) from (
          select l.job_id, j.job_no, j.part_label, l.vendor_name, l.return_no, l.returned_on, l.qty_uninspected
            from public.material_return_lots l join public.jobs j on j.id = l.job_id and j.archived_at is null
           where l.voided_at is null and l.qty_uninspected > 0 order by l.returned_on, j.job_no limit 10) z), '[]'::jsonb),
      'pending_payments', case when v_pay then coalesce((select jsonb_agg(to_jsonb(z)) from (
          select job_id, job_no, part_label, vendor_name, total_payable, amount_paid, balance, payment_status, assignment_state
            from public.payment_accounts where balance > 0 order by balance desc limit 8) z), '[]'::jsonb) end,
      'vendor_followups', coalesce((select jsonb_agg(to_jsonb(z) order by z.overdue_jobs desc, z.vendor_name) from (
          select vendor_id, min(vendor_name) as vendor_name, count(*) as overdue_jobs, max(delay_days_current) as max_delay_days,
                 (select x ->> 'label' from jsonb_array_elements(v_rel) x where x ->> 'vendor_id' = reg.vendor_id::text) as reliability_label
            from reg where status = 'Overdue' group by vendor_id
          union all
          select (x ->> 'vendor_id')::uuid, x ->> 'vendor_name', 0, null, x ->> 'label'
            from jsonb_array_elements(v_rel) x
           where x ->> 'label' = 'Needs Improvement'
             and not exists (select 1 from reg where reg.status = 'Overdue' and reg.vendor_id::text = x ->> 'vendor_id')) z), '[]'::jsonb))
  ) into v_out;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Weekly management report
-- ---------------------------------------------------------------------------
create table public.weekly_reports (
  id            uuid primary key default gen_random_uuid(),
  period_start  date not null,
  period_end    date not null,
  kind          text not null check (kind in ('scheduled', 'manual')),
  generated_at  timestamptz not null default now(),
  generated_by  uuid default auth.uid(),
  data          jsonb not null,
  financial     jsonb not null,
  constraint weekly_report_week check (period_end = period_start + 6)
);
create unique index weekly_reports_one_scheduled on public.weekly_reports (period_start) where kind = 'scheduled';
create index weekly_reports_period_idx on public.weekly_reports (period_start desc, generated_at desc);
create trigger weekly_reports_append_only before update or delete on public.weekly_reports for each row execute function private.forbid_change();
create trigger weekly_reports_no_truncate before truncate on public.weekly_reports for each statement execute function private.forbid_change();

-- Figures that depend only on what happened in the period (can be recalculated for any past week).
create or replace function private.weekly_period_metrics(p_start date, p_end date)
returns jsonb language sql stable security definer set search_path = '' as $$
  with jobs as (
    select j.id, j.closed_on,
           coalesce((select min(a.dispatched_on) from public.job_assignments a where a.job_id = j.id), (j.created_at at time zone 'Asia/Kolkata')::date) as start_date,
           not exists (select 1 from public.job_assignments a where a.job_id = j.id and a.state <> 'cancelled')
             and exists (select 1 from public.job_assignments a where a.job_id = j.id) as all_cancelled,
           (select max(a.cancelled_on) from public.job_assignments a where a.job_id = j.id) as last_cancelled_on
      from public.jobs j where j.archived_at is null
  ),
  asg as (
    select a.* from public.job_assignments a join public.jobs j on j.id = a.job_id and j.archived_at is null
  ),
  insp as (
    select q.* from public.quality_inspections q join public.material_returns m on m.id = q.return_id and m.voided_at is null
     where q.voided_at is null and q.inspected_on between p_start and p_end
  )
  select jsonb_build_object(
    'jobs', jsonb_build_object(
      'new', (select count(*) from jobs where start_date between p_start and p_end),
      'completed', (select count(*) from jobs where closed_on between p_start and p_end),
      'cancelled', (select count(*) from jobs where all_cancelled and last_cancelled_on between p_start and p_end)),
    'delivery', (select jsonb_build_object(
      'due', (select count(*) from asg where state <> 'cancelled' and current_commitment_date between p_start and p_end),
      'completed_on_time', count(*) filter (where original_commitment_date is not null and completed_on <= original_commitment_date),
      'completed_late', count(*) filter (where original_commitment_date is not null and completed_on > original_commitment_date),
      'completed_no_commitment', count(*) filter (where original_commitment_date is null),
      'avg_delay_days', round(avg(completed_on - original_commitment_date) filter (where completed_on > original_commitment_date), 1))
      from asg where state = 'completed' and completed_on between p_start and p_end),
    'quality', jsonb_build_object(
      'qty_sent', (select coalesce(sum(qty_sent), 0) from asg where dispatched_on between p_start and p_end),
      'jobs_without_qty', (select count(*) from asg where dispatched_on between p_start and p_end and qty_sent is null),
      'qty_returned', (select coalesce(sum(m.qty_received), 0) from public.material_returns m join public.jobs j on j.id = m.job_id and j.archived_at is null
                        where m.voided_at is null and m.returned_on between p_start and p_end),
      'inspected', (select coalesce(sum(qty_accepted + qty_rejected + qty_rework), 0) from insp),
      'accepted', (select coalesce(sum(qty_accepted), 0) from insp),
      'rejected', (select coalesce(sum(qty_rejected), 0) from insp),
      'rework', (select coalesce(sum(qty_rework), 0) from insp),
      'acceptance_pct', (select case when sum(qty_accepted + qty_rejected + qty_rework) > 0
                                     then round(100.0 * sum(qty_accepted) / sum(qty_accepted + qty_rejected + qty_rework), 1) end from insp)),
    'financial', jsonb_build_object(
      'total_job_value', (select coalesce(sum(amount), 0) from asg where dispatched_on between p_start and p_end),
      'jobs_without_amount', (select count(*) from asg where dispatched_on between p_start and p_end and amount is null),
      'payments_made', (select coalesce(sum(p.amount), 0) from public.vendor_payments p where p.paid_on between p_start and p_end))
  )
$$;

create or replace function private.build_weekly_report(p_start date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_end date := p_start + 6;
  v_today date := private.today_ist();
  v_cur jsonb := private.weekly_period_metrics(p_start, p_start + 6);
  v_prev jsonb := private.weekly_period_metrics(p_start - 7, p_start - 1);
  v_fy_from date;
  v_fy_to date;
  v_rel jsonb;
  v_relcat jsonb;
  v_prev_report public.weekly_reports;
  v_snapshot jsonb;
  v_fin_snapshot jsonb;
begin
  v_fy_from := make_date(extract(year from (case when extract(month from v_end) >= 4 then v_end else v_end - interval '1 year' end))::int, 4, 1);
  v_fy_to := (v_fy_from + interval '1 year' - interval '1 day')::date;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rel from private.reliability_scores(v_fy_from, v_fy_to, null, null, false) x;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_relcat from private.reliability_scores(v_fy_from, v_fy_to, null, null, true) x;

  with reg as (select * from public.job_register where archived_at is null)
  select jsonb_build_object(
      'pending', count(*) filter (where status not in ('Completed', 'Cancelled')),
      'overdue', count(*) filter (where status = 'Overdue'),
      'partially_returned', count(*) filter (where status = 'Partially Returned'),
      'inspection_pending', count(*) filter (where status = 'Quality Inspection Pending'))
    into v_snapshot from reg;
  v_fin_snapshot := jsonb_build_object('outstanding', coalesce((select sum(balance) from private.account_balances() where balance > 0), 0));

  select * into v_prev_report from public.weekly_reports r where r.period_start = p_start - 7 order by (r.kind = 'scheduled') desc, r.generated_at desc limit 1;

  return jsonb_build_object(
    'data', jsonb_build_object(
      'period', jsonb_build_object('start', p_start, 'end', v_end),
      'generated_on', v_today,
      'jobs', (v_cur -> 'jobs') || jsonb_build_object('pending_now', v_snapshot -> 'pending', 'overdue_now', v_snapshot -> 'overdue',
                                                      'partially_returned_now', v_snapshot -> 'partially_returned',
                                                      'inspection_pending_now', v_snapshot -> 'inspection_pending'),
      'delivery', (v_cur -> 'delivery') || jsonb_build_object('vendors_revised', coalesce((
          select jsonb_agg(jsonb_build_object('vendor_id', z.vendor_id, 'vendor_name', z.name, 'revisions', z.n, 'by_vendor', z.nv) order by z.n desc, z.name)
            from (select r.vendor_id, v.name, count(*) as n, count(*) filter (where r.requested_by = 'vendor') as nv
                    from public.commitment_revisions r join public.vendors v on v.id = r.vendor_id
                   where r.changed_on between p_start and v_end group by 1, 2) z), '[]'::jsonb)),
      'vendors', jsonb_build_object(
        'fy', private.fy_label(v_end),
        'best', coalesce((select jsonb_agg(x order by (x ->> 'score')::numeric desc) from (
            select jsonb_build_object('vendor_id', x ->> 'vendor_id', 'vendor_name', x ->> 'vendor_name', 'score', (x ->> 'score')::numeric,
                                      'label', x ->> 'label', 'eligible_jobs', (x ->> 'eligible_jobs')::int) as x
              from jsonb_array_elements(v_rel) x where x ->> 'score' is not null order by (x ->> 'score')::numeric desc limit 3) t), '[]'::jsonb),
        'lowest', coalesce((select jsonb_agg(x order by (x ->> 'score')::numeric) from (
            select jsonb_build_object('vendor_id', x ->> 'vendor_id', 'vendor_name', x ->> 'vendor_name', 'score', (x ->> 'score')::numeric,
                                      'label', x ->> 'label', 'eligible_jobs', (x ->> 'eligible_jobs')::int) as x
              from jsonb_array_elements(v_rel) x where x ->> 'score' is not null order by (x ->> 'score')::numeric limit 3) t), '[]'::jsonb),
        'scored_vendors', (select count(*) from jsonb_array_elements(v_rel) x where x ->> 'score' is not null),
        'by_category', coalesce((select jsonb_agg(t.x order by t.x ->> 'category_name') from (
            select distinct on (x ->> 'category_id') jsonb_build_object('category_name', x ->> 'category_name', 'vendor_name', x ->> 'vendor_name',
                     'score', (x ->> 'score')::numeric, 'label', x ->> 'label', 'eligible_jobs', (x ->> 'eligible_jobs')::int) as x
              from jsonb_array_elements(v_relcat) x where x ->> 'score' is not null
             order by x ->> 'category_id', (x ->> 'score')::numeric desc) t), '[]'::jsonb),
        'most_overdue', coalesce((select jsonb_agg(to_jsonb(z) order by z.overdue_jobs desc, z.vendor_name) from (
            select vendor_id, min(vendor_name) as vendor_name, count(*) as overdue_jobs, max(delay_days_current) as max_delay_days
              from public.job_register where archived_at is null and status = 'Overdue' group by vendor_id order by count(*) desc limit 5) z), '[]'::jsonb)),
      'quality', v_cur -> 'quality',
      'followups', jsonb_build_object(
        'due_next_week', coalesce((select jsonb_agg(to_jsonb(z)) from (
            select id, job_no, part_label, vendor_name, current_commitment_date, qty_with_vendor, status from public.job_register
             where archived_at is null and status not in ('Completed', 'Cancelled', 'Draft')
               and current_commitment_date between v_end + 1 and v_end + 7 order by current_commitment_date, job_no limit 25) z), '[]'::jsonb),
        'overdue', coalesce((select jsonb_agg(to_jsonb(z)) from (
            select id, job_no, part_label, vendor_name, current_commitment_date, delay_days_current, qty_with_vendor from public.job_register
             where archived_at is null and status = 'Overdue' order by delay_days_current desc nulls last, job_no limit 25) z), '[]'::jsonb),
        'pending_inspections', coalesce((select jsonb_agg(to_jsonb(z)) from (
            select l.job_id, j.job_no, j.part_label, l.vendor_name, l.returned_on, l.qty_uninspected
              from public.material_return_lots l join public.jobs j on j.id = l.job_id and j.archived_at is null
             where l.voided_at is null and l.qty_uninspected > 0 order by l.returned_on, j.job_no limit 25) z), '[]'::jsonb)),
      'previous', jsonb_build_object(
        'period', jsonb_build_object('start', p_start - 7, 'end', p_start - 1),
        'jobs', v_prev -> 'jobs', 'delivery', v_prev -> 'delivery', 'quality', v_prev -> 'quality',
        'snapshot_from_report', case when v_prev_report.id is not null then jsonb_build_object(
            'generated_at', v_prev_report.generated_at, 'pending_now', v_prev_report.data -> 'jobs' -> 'pending_now',
            'overdue_now', v_prev_report.data -> 'jobs' -> 'overdue_now',
            'partially_returned_now', v_prev_report.data -> 'jobs' -> 'partially_returned_now') end)),
    'financial', (v_cur -> 'financial') || v_fin_snapshot || jsonb_build_object(
      'spending_by_vendor', coalesce((select jsonb_agg(jsonb_build_object('vendor_id', z.vendor_id, 'vendor_name', z.name, 'paid', z.paid) order by z.paid desc)
          from (select p.vendor_id, v.name, sum(p.amount) as paid from public.vendor_payments p join public.vendors v on v.id = p.vendor_id
                 where p.paid_on between p_start and v_end group by 1, 2 having sum(p.amount) <> 0) z), '[]'::jsonb),
      'pending_payments', coalesce((select jsonb_agg(to_jsonb(z)) from (
          select b.job_id, b.job_no, b.vendor_name, b.total_payable, b.paid, b.balance from private.account_balances() b
           where b.balance > 0 order by b.balance desc limit 25) z), '[]'::jsonb),
      'previous', (v_prev -> 'financial') || case when v_prev_report.id is not null
                    then jsonb_build_object('outstanding_from_report', v_prev_report.financial -> 'outstanding') else '{}'::jsonb end));
end;
$$;

-- balances of every payment account, for the report (no permission filter: the report is built by the system)
create or replace function private.account_balances()
returns table (assignment_id uuid, job_id uuid, job_no text, vendor_name text, total_payable numeric, paid numeric, balance numeric)
language sql stable security definer set search_path = '' as $$
  select a.id, a.job_id, j.job_no, v.name, t.payable, t.paid, t.payable - t.paid
    from public.job_assignments a
    join public.jobs j on j.id = a.job_id
    join public.vendors v on v.id = a.vendor_id
   cross join lateral private.account_totals(a.id) t
   where a.amount is not null
$$;

create or replace function private.store_weekly_report(p_start date, p_kind text)
returns public.weekly_reports language plpgsql volatile security definer set search_path = '' as $$
declare b jsonb := private.build_weekly_report(p_start); r public.weekly_reports;
begin
  insert into public.weekly_reports (period_start, period_end, kind, data, financial)
  values (p_start, p_start + 6, p_kind, b -> 'data', b -> 'financial')
  returning * into r;
  perform private.log_event('report.generated', 'reports', null, r.id::text, null,
                            jsonb_build_object('period_start', p_start, 'period_end', p_start + 6, 'kind', p_kind), null);
  return r;
end;
$$;

-- Scheduled: on the configured weekday at or after the configured time (IST), once per week, for the 7 days before.
create or replace function private.run_weekly_report(p_now timestamptz default now())
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  s jsonb := coalesce((select value from public.app_settings where key = 'weekly_report'), '{}'::jsonb);
  v_local timestamp := p_now at time zone 'Asia/Kolkata';
  v_today date := v_local::date;
  v_start date;
  r public.weekly_reports;
begin
  if not coalesce((s ->> 'enabled')::boolean, true) then
    return jsonb_build_object('ran', false, 'reason', 'Weekly report is switched off in Settings.');
  end if;
  if extract(isodow from v_today)::int <> coalesce((s ->> 'weekday')::int, 1)
     or v_local::time < coalesce((s ->> 'run_time_ist')::time, time '08:00') then
    return jsonb_build_object('ran', false, 'reason', 'Not the scheduled day and time.');
  end if;
  v_start := v_today - 7;
  if exists (select 1 from public.weekly_reports where period_start = v_start and kind = 'scheduled') then
    return jsonb_build_object('ran', false, 'reason', 'This week''s report already exists.');
  end if;
  r := private.store_weekly_report(v_start, 'scheduled');
  return jsonb_build_object('ran', true, 'id', r.id, 'period_start', r.period_start);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Report functions for screens (reports.view; money only with payments.view)
-- ---------------------------------------------------------------------------
create or replace function public.list_weekly_reports()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_permission('reports.view');
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'period_start', r.period_start, 'period_end', r.period_end, 'kind', r.kind,
                                                       'generated_at', r.generated_at, 'generated_by_name', private.user_name(r.generated_by),
                                                       'new_jobs', r.data -> 'jobs' -> 'new', 'completed', r.data -> 'jobs' -> 'completed',
                                                       'overdue_now', r.data -> 'jobs' -> 'overdue_now')
                                    order by r.period_start desc, r.generated_at desc)
                     from public.weekly_reports r), '[]'::jsonb);
end;
$$;

create or replace function public.get_weekly_report(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.weekly_reports;
begin
  perform private.require_permission('reports.view');
  select * into r from public.weekly_reports where id = p_id;
  if not found then
    raise exception 'Report not found.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('id', r.id, 'kind', r.kind, 'generated_at', r.generated_at, 'generated_by_name', private.user_name(r.generated_by),
                            'data', r.data, 'financial', case when private.has_permission('payments.view') then r.financial end);
end;
$$;

-- Generate (or regenerate) the report for the week starting p_start (a Monday is suggested, any day is allowed).
create or replace function public.generate_weekly_report(p_start date)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r public.weekly_reports;
begin
  perform private.require_permission('reports.view');
  if p_start is null or p_start + 6 >= private.today_ist() then
    raise exception 'Choose a week that has already ended.' using errcode = '22023';
  end if;
  if p_start < date '2015-01-01' then
    raise exception 'Choose a week from 2015 onwards.' using errcode = '22023';
  end if;
  r := private.store_weekly_report(p_start, 'manual');
  return jsonb_build_object('id', r.id);
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'cess-weekly-report') then
    perform cron.unschedule('cess-weekly-report');
  end if;
  perform cron.schedule('cess-weekly-report', '*/15 * * * *', 'select private.run_weekly_report()');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
alter table public.weekly_reports enable row level security;
revoke all on public.weekly_reports from anon, authenticated;
revoke update, delete, truncate on public.weekly_reports from service_role;   -- read only through get_weekly_report()

revoke all on public.job_register from anon, authenticated;
grant select on public.job_register to authenticated;

revoke execute on function public.dashboard_data(text), public.list_weekly_reports(), public.get_weekly_report(uuid), public.generate_weekly_report(date)
from public, anon;
grant execute on function public.dashboard_data(text), public.list_weekly_reports(), public.get_weekly_report(uuid), public.generate_weekly_report(date)
to authenticated;
revoke execute on function private.weekly_period_metrics(date, date), private.build_weekly_report(date), private.account_balances(),
  private.store_weekly_report(date, text), private.run_weekly_report(timestamptz)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Quality records (inspection history with job, part, category and vendor; visibility follows the jobs)
-- ---------------------------------------------------------------------------
create view public.quality_records with (security_invoker = true) as
select q.id, q.job_id, j.job_no, j.part_label, c.name as category_name, j.category_id, q.vendor_id, v.name as vendor_name,
       m.return_no, m.returned_on, m.qty_received, m.challan_no,
       q.inspected_on, q.qty_accepted, q.qty_rejected, q.qty_rework, q.qty_accepted + q.qty_rejected + q.qty_rework as qty_inspected,
       private.quality_status(q.qty_accepted, q.qty_rejected, q.qty_rework, 0) as quality_status,
       q.inspector_name, q.remarks, private.user_name(q.created_by) as recorded_by_name, q.created_at,
       private.fy_label(q.inspected_on) as financial_year
  from public.quality_inspections q
  join public.material_returns m on m.id = q.return_id and m.voided_at is null
  join public.jobs j on j.id = q.job_id and j.archived_at is null
  join public.work_categories c on c.id = j.category_id
  join public.vendors v on v.id = q.vendor_id
 where q.voided_at is null;

revoke all on public.quality_records from anon, authenticated;
grant select on public.quality_records to authenticated;
