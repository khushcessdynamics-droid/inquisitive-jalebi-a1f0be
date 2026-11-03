-- Speed: the Jobs Register view (used by the register, Excel export, dashboard and weekly report) works out the quantities
-- (received, accepted, rejected, rework, awaiting inspection, still with the vendor) inline instead of calling
-- private.assignment_quantities() once per job. Same columns and the same values: the returns and inspections a user may read
-- follow the job's own visibility (their read policies), and the view runs with the caller's rights as before.
-- Measured with 5,000 jobs: totals over the register 0.20 s -> 0.05 s, all rows 0.6-0.9 s -> 0.4 s; every row identical.

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
left join lateral (
  select coalesce(sum(m.qty_received), 0)::int as received
    from public.material_returns m where m.assignment_id = cur.id and m.voided_at is null
) rr on cur.id is not null
left join lateral (
  select coalesce(sum(q.qty_accepted), 0)::int as acc, coalesce(sum(q.qty_rejected), 0)::int as rej, coalesce(sum(q.qty_rework), 0)::int as rwk
    from public.quality_inspections q
    join public.material_returns m on m.id = q.return_id and m.voided_at is null
   where q.assignment_id = cur.id and q.voided_at is null
) ii on cur.id is not null
left join lateral (
  select rr.received, ii.acc as accepted, ii.rej as rejected, ii.rwk as rework,
         rr.received - (ii.acc + ii.rej + ii.rwk) as awaiting,
         case when cur.qty_sent is not null then cur.qty_sent - rr.received + ii.rwk end as with_vendor
   where cur.id is not null
) qty on true
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
