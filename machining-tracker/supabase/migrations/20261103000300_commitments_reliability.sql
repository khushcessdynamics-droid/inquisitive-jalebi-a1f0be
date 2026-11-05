-- =====================================================================================
-- Phase 5 (part 1): vendor commitment revision history and the six-factor vendor reliability score.
-- Rules: docs/RELIABILITY_RULES.md. The original commitment date is never changed; every revision is a new,
-- permanent history row. The score is calculated on every request from the recorded jobs (nothing is cached).
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 1. Commitment revision history (append-only)
-- ---------------------------------------------------------------------------
create table public.commitment_revisions (
  id             uuid primary key default gen_random_uuid(),
  assignment_id  uuid not null references public.job_assignments (id),
  job_id         uuid not null references public.jobs (id),
  vendor_id      uuid not null references public.vendors (id),
  revision_no    integer not null check (revision_no > 0),
  original_date  date not null,
  previous_date  date not null,
  new_date       date not null,
  changed_on     date not null,
  -- 'vendor': the vendor asked for more time (counts in "commitment stability");
  -- 'cess':   CESS asked for the change (e.g. drawing changed, material late); not held against the vendor.
  requested_by   text not null check (requested_by in ('vendor', 'cess')),
  reason         text not null check (length(trim(reason)) between 3 and 1000),
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  unique (assignment_id, revision_no),
  constraint revision_changes_date check (new_date <> previous_date)
);
create index commitment_revisions_job_idx on public.commitment_revisions (job_id);
create index commitment_revisions_vendor_idx on public.commitment_revisions (vendor_id);

create trigger commitment_revisions_append_only before update or delete on public.commitment_revisions
  for each row execute function private.forbid_change();
create trigger commitment_revisions_no_truncate before truncate on public.commitment_revisions
  for each statement execute function private.forbid_change();

-- Revise the committed date of the current (open) vendor assignment. Keeps the original date, writes a numbered
-- history row and an Activity History entry. Needs "Revise vendor commitment dates".
create or replace function public.revise_commitment(
  p_assignment_id uuid, p_expected_version integer, p_new_date date, p_requested_by text, p_reason text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.job_assignments;
  v_job public.jobs;
  v_reason text;
  v_no integer;
  v_rev public.commitment_revisions;
  v_prev date;
begin
  perform private.require_permission('commitments.change');
  select * into a from public.job_assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'Vendor assignment not found.' using errcode = 'P0002';
  end if;
  if not private.can_view_job(a.job_id) then
    raise exception 'You do not have permission for this job.' using errcode = '42501';
  end if;
  perform private.require_version(a.version, p_expected_version, 'This vendor assignment');
  select * into v_job from public.jobs where id = a.job_id;
  if a.state <> 'open' or v_job.closed_at is not null or v_job.archived_at is not null then
    raise exception 'Only the current vendor of an open job can have the committed date revised.' using errcode = '22023';
  end if;
  if a.current_commitment_date is null then
    raise exception 'No committed date is recorded yet. Record the vendor''s committed date first (it becomes the original date).'
      using errcode = '22023';
  end if;
  if p_new_date is null then
    raise exception 'Enter the new committed date.' using errcode = '22023';
  end if;
  if p_new_date = a.current_commitment_date then
    raise exception 'The new date is the same as the current committed date.' using errcode = '22023';
  end if;
  if p_new_date < a.dispatched_on then
    raise exception 'The committed date cannot be before the date given to the vendor.' using errcode = '22023';
  end if;
  if p_new_date > a.dispatched_on + 730 then
    raise exception 'The committed date must be within two years of the date given to the vendor.' using errcode = '22023';
  end if;
  if coalesce(p_requested_by, '') not in ('vendor', 'cess') then
    raise exception 'Choose who asked for the change: the vendor or CESS.' using errcode = '22023';
  end if;
  v_reason := private.require_reason(p_reason);
  if length(v_reason) > 1000 then
    raise exception 'The reason can have at most 1000 characters.' using errcode = '22023';
  end if;

  v_prev := a.current_commitment_date;
  select coalesce(max(revision_no), 0) + 1 into v_no from public.commitment_revisions where assignment_id = a.id;

  perform private.set_audit_context('job.commitment_revised',
    v_reason || case p_requested_by when 'vendor' then ' (requested by vendor)' else ' (requested by CESS)' end);
  perform set_config('cess.commitment_revision', 'on', true);
  update public.job_assignments set current_commitment_date = p_new_date where id = a.id returning * into a;
  perform set_config('cess.commitment_revision', '', true);
  perform private.set_audit_context(null, null);

  insert into public.commitment_revisions
    (assignment_id, job_id, vendor_id, revision_no, original_date, previous_date, new_date, changed_on, requested_by, reason)
  values
    (a.id, a.job_id, a.vendor_id, v_no, a.original_commitment_date, v_prev, p_new_date, private.today_ist(), p_requested_by, v_reason)
  returning * into v_rev;

  return jsonb_build_object('assignment', to_jsonb(a), 'revision', to_jsonb(v_rev));
end;
$$;

-- Readable history for screens (names resolved; row visibility follows the jobs the user can see)
create view public.commitment_history with (security_invoker = true) as
select r.id, r.assignment_id, r.job_id, r.vendor_id, r.revision_no, r.original_date, r.previous_date, r.new_date,
       r.new_date - r.previous_date as days_moved, r.new_date - r.original_date as days_from_original,
       r.changed_on, r.requested_by, r.reason, r.created_at, r.created_by,
       private.user_name(r.created_by) as changed_by_name,
       j.job_no, j.part_label, v.name as vendor_name
  from public.commitment_revisions r
  join public.jobs j on j.id = r.job_id
  join public.vendors v on v.id = r.vendor_id;

-- ---------------------------------------------------------------------------
-- 2. Job register: add the revision count of the current assignment (columns appended; nothing else changes)
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
  (select count(*)::int from public.commitment_revisions r where r.assignment_id = cur.id) as revision_count
from public.jobs j
join public.work_categories c on c.id = j.category_id
left join public.given_by_names g on g.id = j.given_by_id
left join lateral (
  select a.* from public.job_assignments a where a.job_id = j.id
  order by (a.state = 'open') desc, a.sequence_no desc limit 1
) cur on true
left join public.vendors v on v.id = cur.vendor_id
cross join lateral (
  select private.today_ist() as today,
         private.setting_int('jobs', 'due_soon_days', 3) as due_soon,
         private.setting_int('jobs', 'long_pending_days', 10) as long_days
) cfg
cross join lateral (
  select private.job_status(j.closed_at is not null, cur.id is not null,
                            case when cur.state = 'open' then cur.dispatched_on end,
                            case when cur.state = 'open' then cur.current_commitment_date end,
                            cfg.today, cfg.due_soon) as status
) st;

-- ---------------------------------------------------------------------------
-- 3. Reliability: classification of every vendor assignment (one bucket each, no double counting)
-- ---------------------------------------------------------------------------
-- Buckets: completed | vendor_cancelled | other_cancelled | unclassified_cancelled | open | closed_no_return
-- Period filters apply to the date the job was given to the vendor. Archived jobs are never counted.
create or replace function private.reliability_assignments(p_from date, p_to date, p_category uuid)
returns table (
  assignment_id uuid, job_id uuid, job_no text, part_label text, category_id uuid, category_name text,
  vendor_id uuid, vendor_name text, sequence_no integer, dispatched_on date,
  original_commitment_date date, current_commitment_date date, completed_on date, cancelled_on date,
  cancel_reason_code text, cancel_reason_label text, bucket text,
  days_taken integer, late_days integer, late_days_current integer,
  revisions integer, vendor_revisions integer, overdue_now boolean, category_median_days numeric
) language sql stable security definer set search_path = '' as $$
  with base as (
    select a.id, a.job_id, j.job_no, j.part_label, j.category_id, c.name as category_name,
           a.vendor_id, v.name as vendor_name, a.sequence_no, a.dispatched_on,
           a.original_commitment_date, a.current_commitment_date, a.completed_on, a.cancelled_on,
           a.cancel_reason_code, r.label as cancel_reason_label,
           case
             when a.state = 'completed' then 'completed'
             when a.state = 'cancelled' and r.vendor_related then 'vendor_cancelled'
             when a.state = 'cancelled' and a.cancel_reason_code = 'legacy_unclassified' then 'unclassified_cancelled'
             when a.state = 'cancelled' then 'other_cancelled'
             when j.closed_at is not null then 'closed_no_return'
             else 'open'
           end as bucket,
           (select count(*)::int from public.commitment_revisions cr where cr.assignment_id = a.id) as revisions,
           (select count(*)::int from public.commitment_revisions cr where cr.assignment_id = a.id and cr.requested_by = 'vendor') as vendor_revisions
      from public.job_assignments a
      join public.jobs j on j.id = a.job_id and j.archived_at is null
      join public.work_categories c on c.id = j.category_id
      join public.vendors v on v.id = a.vendor_id
      left join public.cancel_reason_codes r on r.code = a.cancel_reason_code
     where (p_from is null or a.dispatched_on >= p_from)
       and (p_to is null or a.dispatched_on <= p_to)
       and (p_category is null or j.category_id = p_category)
  ),
  medians as (
    -- the "usual" completion time of a category: needs at least 3 completed jobs from at least 2 vendors
    select b.category_id,
           percentile_cont(0.5) within group (order by greatest(b.completed_on - b.dispatched_on, 1))::numeric as median_days
      from base b
     where b.bucket = 'completed'
     group by b.category_id
    having count(*) >= 3 and count(distinct b.vendor_id) >= 2
  )
  select b.id, b.job_id, b.job_no, b.part_label, b.category_id, b.category_name,
         b.vendor_id, b.vendor_name, b.sequence_no, b.dispatched_on,
         b.original_commitment_date, b.current_commitment_date, b.completed_on, b.cancelled_on,
         b.cancel_reason_code, b.cancel_reason_label, b.bucket,
         case when b.bucket = 'completed' then b.completed_on - b.dispatched_on end,
         case when b.bucket = 'completed' and b.original_commitment_date is not null
              then greatest(0, b.completed_on - b.original_commitment_date) end,
         case when b.bucket = 'completed' and b.current_commitment_date is not null
              then greatest(0, b.completed_on - b.current_commitment_date) end,
         b.revisions, b.vendor_revisions,
         (b.bucket = 'open' and b.current_commitment_date < private.today_ist()),
         m.median_days
    from base b
    left join medians m on m.category_id = b.category_id
$$;

-- Factor scores, renormalised weighted score and supporting numbers per vendor (or per vendor + category).
create or replace function private.reliability_scores(p_from date, p_to date, p_category uuid, p_vendor uuid, p_by_category boolean)
returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s jsonb := coalesce((select value from public.app_settings where key = 'reliability'), '{}'::jsonb);
  w jsonb := coalesce(s -> 'weights', '{}'::jsonb);
  v_min_jobs integer := coalesce((s ->> 'min_eligible_jobs')::integer, 5);
  v_min_factors integer := coalesce((s ->> 'min_factors')::integer, 3);
  v_cap numeric := coalesce((s ->> 'delay_cap_days')::numeric, 14);
  v_rev_cap numeric := coalesce((s ->> 'stability_revisions_cap')::numeric, 2);
  v_excellent numeric := coalesce((s -> 'labels' ->> 'excellent')::numeric, 85);
  v_good numeric := coalesce((s -> 'labels' ->> 'good')::numeric, 70);
  v_average numeric := coalesce((s -> 'labels' ->> 'average')::numeric, 50);
begin
  return query
  with a as (
    select * from private.reliability_assignments(p_from, p_to, p_category) x
     where p_vendor is null or x.vendor_id = p_vendor
  ),
  g as (
    select a.vendor_id,
           min(a.vendor_name) as vendor_name,
           case when p_by_category then a.category_id end as cat_id,
           case when p_by_category then min(a.category_name) end as cat_name,
           count(*) as total,
           count(*) filter (where a.bucket = 'completed') as completed,
           count(*) filter (where a.bucket = 'vendor_cancelled') as vendor_cancelled,
           count(*) filter (where a.bucket = 'other_cancelled') as other_cancelled,
           count(*) filter (where a.bucket = 'unclassified_cancelled') as unclassified_cancelled,
           count(*) filter (where a.bucket = 'open') as open_jobs,
           count(*) filter (where a.bucket = 'open' and a.current_commitment_date is not null) as open_committed,
           count(*) filter (where a.overdue_now) as overdue_now,
           count(*) filter (where a.bucket = 'closed_no_return') as closed_no_return,
           count(*) filter (where a.bucket = 'completed' and a.original_commitment_date is null) as completed_no_commitment,
           count(*) filter (where a.bucket = 'completed' and a.original_commitment_date is not null) as committed_n,
           count(*) filter (where a.bucket = 'completed' and a.late_days = 0) as on_time_n,
           count(*) filter (where a.bucket = 'completed' and a.late_days > 0) as late_n,
           avg(a.late_days) filter (where a.bucket = 'completed' and a.late_days > 0) as avg_late,
           coalesce(sum(a.late_days) filter (where a.bucket = 'completed'), 0) as total_late,
           avg(a.late_days_current) filter (where a.bucket = 'completed' and a.late_days_current > 0) as avg_late_current,
           count(*) filter (where a.bucket = 'completed' and a.late_days_current > 0) as late_current_n,
           coalesce(sum(a.vendor_revisions) filter (where a.bucket = 'completed' and a.original_commitment_date is not null), 0) as stab_revisions,
           coalesce(sum(a.revisions), 0) as revisions_all,
           coalesce(sum(a.vendor_revisions), 0) as revisions_vendor,
           count(*) filter (where a.revisions > 0) as revised_jobs,
           count(*) filter (where a.current_commitment_date is not null) as committed_all,
           coalesce(max(a.revisions), 0) as max_revisions,
           count(*) filter (where a.bucket = 'completed' and a.category_median_days is not null) as ct_n,
           sum(a.category_median_days) filter (where a.bucket = 'completed' and a.category_median_days is not null) as ct_expected,
           sum(greatest(a.days_taken, 1)) filter (where a.bucket = 'completed' and a.category_median_days is not null) as ct_actual,
           avg(a.days_taken) filter (where a.bucket = 'completed') as avg_days
      from a
     group by a.vendor_id, case when p_by_category then a.category_id end
  ),
  cr as (
    -- cancellations broken out by reason (vendor-caused first); shown beside the score, not scored again
    select z.vendor_id, z.cat_id,
           jsonb_agg(jsonb_build_object('code', z.code, 'label', z.label, 'vendor_caused', z.vc, 'count', z.n)
                     order by z.vc desc, z.n desc, z.code) as cancel_reasons
      from (select a.vendor_id, case when p_by_category then a.category_id end as cat_id,
                   a.cancel_reason_code as code, min(a.cancel_reason_label) as label,
                   bool_or(a.bucket = 'vendor_cancelled') as vc, count(*) as n
              from a
             where a.bucket in ('vendor_cancelled', 'other_cancelled', 'unclassified_cancelled')
             group by 1, 2, 3) z
     group by z.vendor_id, z.cat_id
  ),
  f as (
    select g.*, coalesce(cr.cancel_reasons, '[]'::jsonb) as cancel_reasons,
           case when committed_n > 0 then 100.0 * on_time_n / committed_n end as s_on_time,
           case when committed_n > 0 then
             case when late_n = 0 then 100.0 else 100.0 * (1 - least(1, avg_late / v_cap)) end end as s_delay,
           case when committed_n > 0 then 100.0 * (1 - least(1, stab_revisions::numeric / committed_n / v_rev_cap)) end as s_stability,
           case when ct_n > 0 and ct_actual > 0 then 100.0 * least(1, ct_expected / ct_actual) end as s_completion,
           case when completed + vendor_cancelled > 0 then 100.0 * (1 - vendor_cancelled::numeric / (completed + vendor_cancelled)) end as s_cancel,
           null::numeric as s_quality
      from g
      left join cr on cr.vendor_id = g.vendor_id and cr.cat_id is not distinct from g.cat_id
  ),
  fx as (
    select f.*, k.*
      from f
     cross join lateral (
       select jsonb_agg(jsonb_build_object(
                'key', x.key, 'weight', x.w, 'score', round(x.s, 1), 'jobs', x.n, 'used', x.s is not null and x.w > 0,
                'note', x.note) order by x.ord) as factors,
              coalesce(sum(x.w) filter (where x.s is not null and x.w > 0), 0) as w_avail,
              count(*) filter (where x.s is not null and x.w > 0) as k_avail,
              sum(x.w * x.s) filter (where x.s is not null and x.w > 0) as ws
         from (values
           (1, 'on_time', coalesce((w ->> 'on_time')::numeric, 0), f.s_on_time, f.committed_n,
               format('%s of %s completed jobs returned on or before the original committed date', f.on_time_n, f.committed_n)),
           (2, 'quality', coalesce((w ->> 'quality')::numeric, 0), f.s_quality, 0::bigint,
               'No quality inspections recorded yet (material return and inspection arrive in Phase 6)'),
           (3, 'delay', coalesce((w ->> 'delay')::numeric, 0), f.s_delay, f.committed_n,
               case when f.late_n = 0 then format('None of %s completed jobs was late', f.committed_n)
                    else format('%s late %s, average %s days late (limit %s days)', f.late_n,
                                case when f.late_n = 1 then 'job' else 'jobs' end, round(f.avg_late, 1), v_cap) end),
           (4, 'stability', coalesce((w ->> 'stability')::numeric, 0), f.s_stability, f.committed_n,
               format('%s vendor-requested %s over %s completed jobs (limit %s per job)', f.stab_revisions,
                      case when f.stab_revisions = 1 then 'revision' else 'revisions' end, f.committed_n, v_rev_cap)),
           (5, 'completion_time', coalesce((w ->> 'completion_time')::numeric, 0), f.s_completion, f.ct_n,
               case when f.ct_n = 0 then 'Not enough completed jobs in the category to set a usual time (3 jobs from 2 vendors)'
                    else format('%s days expected (category median) vs %s days taken, over %s jobs', round(f.ct_expected, 1), f.ct_actual, f.ct_n) end),
           (6, 'vendor_cancellation', coalesce((w ->> 'vendor_cancellation')::numeric, 0), f.s_cancel, f.completed + f.vendor_cancelled,
               format('%s vendor-caused %s out of %s eligible jobs', f.vendor_cancelled,
                      case when f.vendor_cancelled = 1 then 'cancellation' else 'cancellations' end, f.completed + f.vendor_cancelled))
         ) as x(ord, key, w, s, n, note)
     ) k
  )
  select jsonb_build_object(
           'vendor_id', fx.vendor_id,
           'vendor_name', fx.vendor_name,
           'category_id', fx.cat_id,
           'category_name', fx.cat_name,
           'score', case when sc.ok then round(fx.ws / fx.w_avail, 1) end,
           'label', case when not sc.ok then null
                         when fx.ws / fx.w_avail >= v_excellent then 'Excellent'
                         when fx.ws / fx.w_avail >= v_good then 'Good'
                         when fx.ws / fx.w_avail >= v_average then 'Average'
                         else 'Needs Improvement' end,
           'status', case when (fx.completed + fx.vendor_cancelled) < v_min_jobs then 'insufficient_jobs'
                          when fx.k_avail < v_min_factors or fx.w_avail = 0 then 'insufficient_factors'
                          else 'scored' end,
           'eligible_jobs', fx.completed + fx.vendor_cancelled,
           'min_eligible_jobs', v_min_jobs,
           'factors_used', fx.k_avail,
           'min_factors', v_min_factors,
           'weight_used', fx.w_avail,
           'factors', fx.factors,
           'counts', jsonb_build_object(
              'total', fx.total, 'completed', fx.completed, 'vendor_cancelled', fx.vendor_cancelled,
              'other_cancelled', fx.other_cancelled, 'unclassified_cancelled', fx.unclassified_cancelled,
              'open', fx.open_jobs, 'open_committed', fx.open_committed, 'overdue_now', fx.overdue_now,
              'closed_no_return', fx.closed_no_return, 'completed_no_commitment', fx.completed_no_commitment,
              'committed_completed', fx.committed_n, 'on_time', fx.on_time_n, 'late', fx.late_n),
           'measures', jsonb_build_object(
              'on_time_pct', case when fx.committed_n > 0 then round(100.0 * fx.on_time_n / fx.committed_n, 1) end,
              'overdue_now_pct', case when fx.open_committed > 0 then round(100.0 * fx.overdue_now / fx.open_committed, 1) end,
              'avg_delay_when_late', round(fx.avg_late, 1),
              'avg_delay_when_late_vs_latest', round(fx.avg_late_current, 1),
              'late_vs_latest', fx.late_current_n,
              'avg_delay_all', case when fx.committed_n > 0 then round(fx.total_late::numeric / fx.committed_n, 1) end,
              'total_delay_days', fx.total_late,
              'avg_days_taken', round(fx.avg_days, 1),
              'quality_acceptance_pct', null,
              'rework_rejection_pct', null,
              'revisions', fx.revisions_all,
              'revisions_vendor', fx.revisions_vendor,
              'revisions_per_committed_job', case when fx.committed_all > 0 then round(fx.revisions_all::numeric / fx.committed_all, 2) end,
              'revised_jobs', fx.revised_jobs,
              'committed_jobs', fx.committed_all,
              'max_revisions_one_job', fx.max_revisions,
              -- "frequently revises": at least 3 committed jobs and half or more of them revised, or one job revised
              -- as often as the stability limit
              'frequent_reviser', (fx.committed_all >= 3 and fx.revised_jobs * 2 >= fx.committed_all) or fx.max_revisions >= v_rev_cap),
           'cancel_reasons', fx.cancel_reasons
         )
    from fx
   cross join lateral (
     select (fx.completed + fx.vendor_cancelled) >= v_min_jobs and fx.k_avail >= v_min_factors and fx.w_avail > 0 as ok
   ) sc
   order by case when sc.ok then fx.ws / fx.w_avail end desc nulls last, fx.completed + fx.vendor_cancelled desc, fx.vendor_name;
end;
$$;

-- Filter payload: { fy: "2026-27", from: "YYYY-MM-DD", to: "YYYY-MM-DD", category_id, vendor_id, by_category }
create or replace function private.reliability_period(p jsonb, out p_from date, out p_to date)
language plpgsql immutable set search_path = '' as $$
declare v_fy text := nullif(trim(coalesce(p ->> 'fy', '')), ''); v_year integer;
begin
  if v_fy is not null then
    if v_fy !~ '^\d{4}-\d{2}$' then
      raise exception 'Financial year must look like 2026-27.' using errcode = '22023';
    end if;
    v_year := left(v_fy, 4)::integer;
    if right(v_fy, 2)::integer <> (v_year + 1) % 100 then
      raise exception 'Financial year must look like 2026-27.' using errcode = '22023';
    end if;
    p_from := make_date(v_year, 4, 1);
    p_to := make_date(v_year + 1, 3, 31);
  end if;
  if private.j_date(p, 'from', false, 'From date') is not null then
    p_from := greatest(p_from, private.j_date(p, 'from', false, 'From date'));
  end if;
  if private.j_date(p, 'to', false, 'To date') is not null then
    p_to := least(p_to, private.j_date(p, 'to', false, 'To date'));
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'The From date must be before the To date.' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.vendor_reliability(p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date; v_to date; v_rows jsonb;
  v_cat uuid := private.j_uuid(coalesce(p, '{}'::jsonb), 'category_id', false, 'Category');
  v_vendor uuid := private.j_uuid(coalesce(p, '{}'::jsonb), 'vendor_id', false, 'Vendor');
  v_by_cat boolean := coalesce((p ->> 'by_category')::boolean, false);
begin
  perform private.require_permission('reliability.view');
  select r.p_from, r.p_to into v_from, v_to from private.reliability_period(coalesce(p, '{}'::jsonb)) r;
  select coalesce(jsonb_agg(t.x || jsonb_build_object('rank', case when t.x ->> 'score' is not null then t.ord end) order by t.ord), '[]'::jsonb)
    into v_rows
    from private.reliability_scores(v_from, v_to, v_cat, v_vendor, v_by_cat) with ordinality as t(x, ord);
  return jsonb_build_object(
    'settings', (select value from public.app_settings where key = 'reliability'),
    'from', v_from, 'to', v_to, 'category_id', v_cat, 'vendor_id', v_vendor, 'by_category', v_by_cat,
    'today', private.today_ist(),
    'rows', v_rows);
end;
$$;

-- "How this score was calculated": every assignment of one vendor in the period, with its bucket and the
-- factors it was used in.
create or replace function public.vendor_reliability_jobs(p_vendor_id uuid, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_from date; v_to date; v_cat uuid := private.j_uuid(coalesce(p, '{}'::jsonb), 'category_id', false, 'Category');
begin
  perform private.require_permission('reliability.view');
  if p_vendor_id is null then
    raise exception 'Vendor is required.' using errcode = '22023';
  end if;
  select r.p_from, r.p_to into v_from, v_to from private.reliability_period(coalesce(p, '{}'::jsonb)) r;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'assignment_id', x.assignment_id, 'job_id', x.job_id, 'job_no', x.job_no, 'part_label', x.part_label,
             'category_name', x.category_name, 'sequence_no', x.sequence_no, 'dispatched_on', x.dispatched_on,
             'original_commitment_date', x.original_commitment_date, 'current_commitment_date', x.current_commitment_date,
             'completed_on', x.completed_on, 'cancelled_on', x.cancelled_on,
             'cancel_reason_code', x.cancel_reason_code, 'cancel_reason_label', x.cancel_reason_label,
             'bucket', x.bucket, 'days_taken', x.days_taken, 'late_days', x.late_days, 'late_days_current', x.late_days_current,
             'revisions', x.revisions, 'vendor_revisions', x.vendor_revisions, 'overdue_now', x.overdue_now,
             'category_median_days', x.category_median_days,
             'used_in', to_jsonb(array_remove(array[
                case when x.bucket = 'completed' and x.original_commitment_date is not null then 'on_time' end,
                case when x.bucket = 'completed' and x.original_commitment_date is not null then 'delay' end,
                case when x.bucket = 'completed' and x.original_commitment_date is not null then 'stability' end,
                case when x.bucket = 'completed' and x.category_median_days is not null then 'completion_time' end,
                case when x.bucket in ('completed', 'vendor_cancelled') then 'vendor_cancellation' end], null)),
             'excluded_because', case x.bucket
                when 'other_cancelled' then 'Cancelled for a reason not caused by the vendor'
                when 'unclassified_cancelled' then 'Imported cancellation without a reason: classify it in Missing Data Review'
                when 'open' then 'Still with the vendor'
                when 'closed_no_return' then 'Job closed without a recorded return'
                when 'completed' then case when x.original_commitment_date is null
                  then 'No committed date: left out of on-time, delay and stability' end
             end)
           order by x.dispatched_on desc, x.job_no)
      from private.reliability_assignments(v_from, v_to, v_cat) x
     where x.vendor_id = p_vendor_id), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Row Level Security, grants, realtime
-- ---------------------------------------------------------------------------
alter table public.commitment_revisions enable row level security;
revoke all on public.commitment_revisions from anon, authenticated;
grant select on public.commitment_revisions to authenticated;
revoke update, delete, truncate on public.commitment_revisions from service_role;
create policy commitment_revisions_read on public.commitment_revisions for select to authenticated using (
  (select private.has_permission('jobs.view_all'))
  or exists (select 1 from public.jobs j where j.id = job_id));  -- jobs RLS decides

revoke all on public.job_register, public.commitment_history from anon, authenticated;
grant select on public.job_register, public.commitment_history to authenticated;

revoke execute on function public.revise_commitment(uuid, integer, date, text, text) from public, anon;
revoke execute on function public.vendor_reliability(jsonb) from public, anon;
revoke execute on function public.vendor_reliability_jobs(uuid, jsonb) from public, anon;
grant execute on function public.revise_commitment(uuid, integer, date, text, text), public.vendor_reliability(jsonb),
  public.vendor_reliability_jobs(uuid, jsonb) to authenticated;

-- internal building blocks: reachable only through the permission-checked public functions above
revoke execute on function private.reliability_assignments(date, date, uuid) from public, anon, authenticated, service_role;
revoke execute on function private.reliability_scores(date, date, uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke execute on function private.reliability_period(jsonb) from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.commitment_revisions;
  end if;
end;
$$;
