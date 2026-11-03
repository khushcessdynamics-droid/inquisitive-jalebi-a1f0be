-- =====================================================================================
-- Phase 4 functions. Every change goes through these permission-checked functions (one transaction each);
-- tables are not writable directly through the API.
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
-- Payload: part_label, description, qty_sent, category_id, given_by_id, assigned_staff_id, remarks,
--          vendor: { vendor_id, dispatched_on, qty_sent, amount, commitment_date, remarks }  (omit vendor = Draft)
create or replace function public.create_job(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_part text;
  v_cat uuid;
  v_gb uuid;
  v_staff uuid;
  v_qty integer;
  v_job uuid;
  v_job_no text;
  v_fy text;
  v_assign uuid;
begin
  perform private.require_permission('jobs.create');
  v_part := private.j_text(p, 'part_label', 200, true, 'Part No / Part Name');
  v_cat := private.j_uuid(p, 'category_id', true, 'Work category');
  if not exists (select 1 from public.work_categories where id = v_cat and is_active) then
    raise exception 'Choose an active work category.' using errcode = '22023';
  end if;
  v_gb := private.j_uuid(p, 'given_by_id', false, 'Given By');
  if v_gb is not null and not exists (select 1 from public.given_by_names where id = v_gb and is_active) then
    raise exception 'Choose an active Given By name.' using errcode = '22023';
  end if;
  v_staff := private.j_uuid(p, 'assigned_staff_id', false, 'Assigned staff user');
  if v_staff is not null and not exists (select 1 from public.profiles where id = v_staff and is_active) then
    raise exception 'The assigned staff user must be an active user.' using errcode = '22023';
  end if;
  v_qty := private.j_int(p, 'qty_sent', 'Quantity sent');

  v_fy := private.fy_code(private.today_ist());
  v_job_no := 'JOB-' || v_fy || '-' || lpad(private.next_number('job:' || v_fy)::text, 4, '0');
  perform private.set_audit_context('job.created', null);
  insert into public.jobs (job_no, part_label, description, qty_sent, category_id, given_by_id, assigned_staff_id, remarks)
  values (v_job_no, v_part, coalesce(private.j_text(p, 'description', 2000, false, 'Description'), ''), v_qty, v_cat, v_gb, v_staff,
          coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), ''))
  returning id into v_job;

  if jsonb_typeof(p -> 'vendor') = 'object' then
    perform private.set_audit_context('job.sent_to_vendor', null);
    v_assign := private.add_assignment(v_job, p -> 'vendor', v_qty, null);
  end if;
  perform private.set_audit_context(null, null);
  return jsonb_build_object('id', v_job, 'job_no', v_job_no, 'assignment_id', v_assign);
end;
$$;

-- Partial update: only keys present in p are changed. Staff (operational edit) may change description, remarks
-- and an unknown quantity; full edit also part, category, Given By, assigned user.
create or replace function public.update_job(p_job_id uuid, p_expected_version integer, p jsonb, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.jobs;
  v_mode text := private.can_edit_job(p_job_id);
  k text;
begin
  if v_mode is null then
    raise exception 'You do not have permission to edit this job.' using errcode = '42501';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  perform private.require_version(v_job.version, p_expected_version, 'This job');
  if v_job.archived_at is not null then
    raise exception 'Archived jobs cannot be edited.' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('part_label', 'description', 'qty_sent', 'category_id', 'given_by_id', 'assigned_staff_id', 'remarks') then
      raise exception 'Field "%" cannot be changed here.', k using errcode = '22023';
    end if;
    if v_mode = 'operational' and k not in ('description', 'remarks', 'qty_sent') then
      raise exception 'Your role can change only the description, remarks and an unknown quantity.' using errcode = '42501';
    end if;
  end loop;
  if v_mode = 'operational' and p ? 'qty_sent' and v_job.qty_sent is not null then
    raise exception 'Only a Manager or Admin can change a quantity that is already recorded.' using errcode = '42501';
  end if;
  if v_job.closed_at is not null and (p ? 'part_label' or p ? 'category_id' or p ? 'qty_sent') then
    raise exception 'Part, category and quantity of a completed job cannot be changed.' using errcode = '22023';
  end if;
  if p ? 'category_id' and not exists (select 1 from public.work_categories where id = private.j_uuid(p, 'category_id', true, 'Work category') and is_active) then
    raise exception 'Choose an active work category.' using errcode = '22023';
  end if;
  if private.j_uuid(p, 'given_by_id', false, 'Given By') is not null
     and not exists (select 1 from public.given_by_names where id = private.j_uuid(p, 'given_by_id', false, 'Given By') and is_active) then
    raise exception 'Choose an active Given By name.' using errcode = '22023';
  end if;
  if private.j_uuid(p, 'assigned_staff_id', false, 'Assigned staff user') is not null
     and not exists (select 1 from public.profiles where id = private.j_uuid(p, 'assigned_staff_id', false, 'Assigned staff user') and is_active) then
    raise exception 'The assigned staff user must be an active user.' using errcode = '22023';
  end if;

  perform private.set_audit_context('job.updated', nullif(trim(coalesce(p_reason, '')), ''));
  update public.jobs set
    part_label        = case when p ? 'part_label' then private.j_text(p, 'part_label', 200, true, 'Part No / Part Name') else part_label end,
    description       = case when p ? 'description' then coalesce(private.j_text(p, 'description', 2000, false, 'Description'), '') else description end,
    qty_sent          = case when p ? 'qty_sent' then private.j_int(p, 'qty_sent', 'Quantity sent') else qty_sent end,
    category_id       = case when p ? 'category_id' then private.j_uuid(p, 'category_id', true, 'Work category') else category_id end,
    given_by_id       = case when p ? 'given_by_id' then private.j_uuid(p, 'given_by_id', false, 'Given By') else given_by_id end,
    assigned_staff_id = case when p ? 'assigned_staff_id' then private.j_uuid(p, 'assigned_staff_id', false, 'Assigned staff user') else assigned_staff_id end,
    remarks           = case when p ? 'remarks' then coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), '') else remarks end
  where id = p_job_id
  returning * into v_job;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_job);
end;
$$;

-- Send a Draft job to its first vendor.
create or replace function public.send_job_to_vendor(p_job_id uuid, p_expected_version integer, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.jobs; v_assign uuid;
begin
  perform private.require_permission('jobs.create');
  if not private.can_view_job(p_job_id) then
    raise exception 'You do not have permission for this job.' using errcode = '42501';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  perform private.require_version(v_job.version, p_expected_version, 'This job');
  if v_job.closed_at is not null or v_job.archived_at is not null then
    raise exception 'This job is closed.' using errcode = '22023';
  end if;
  if exists (select 1 from public.job_assignments where job_id = p_job_id) then
    raise exception 'This job was already sent to a vendor. Use "Cancel & forward" to change vendor.' using errcode = '22023';
  end if;
  perform private.set_audit_context('job.sent_to_vendor', null);
  v_assign := private.add_assignment(p_job_id, p, v_job.qty_sent, null);
  update public.jobs set updated_at = now() where id = p_job_id; -- bumps version: the job changed state
  perform private.set_audit_context(null, null);
  return jsonb_build_object('assignment_id', v_assign);
end;
$$;

-- Correct the current (open) vendor assignment. Vendor and date corrections need assignments.change and a reason.
-- The committed delivery date can be entered here only if it was never recorded.
create or replace function public.update_assignment(p_assignment_id uuid, p_expected_version integer, p jsonb, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.job_assignments;
  v_mode text;
  k text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_commit date;
begin
  select * into a from public.job_assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'Vendor assignment not found.' using errcode = 'P0002';
  end if;
  v_mode := private.can_edit_job(a.job_id);
  if v_mode is null then
    raise exception 'You do not have permission to edit this job.' using errcode = '42501';
  end if;
  perform private.require_version(a.version, p_expected_version, 'This vendor assignment');
  if a.state <> 'open' then
    raise exception 'Only the current vendor assignment can be edited.' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('vendor_id', 'dispatched_on', 'qty_sent', 'amount', 'commitment_date', 'remarks') then
      raise exception 'Field "%" cannot be changed here.', k using errcode = '22023';
    end if;
  end loop;
  if (p ? 'vendor_id' and private.j_uuid(p, 'vendor_id', true, 'Vendor') <> a.vendor_id)
     or (p ? 'dispatched_on' and private.j_date(p, 'dispatched_on', true, 'Date given to vendor') <> a.dispatched_on) then
    perform private.require_permission('assignments.change');
    if v_reason is null or length(v_reason) < 3 then
      raise exception 'A reason is required to correct the vendor or the date given.' using errcode = '22023';
    end if;
  end if;
  if (p ? 'amount' or (p ? 'qty_sent' and a.qty_sent is not null)) and v_mode <> 'all' then
    raise exception 'Only a Manager or Admin can change the amount or a recorded quantity.' using errcode = '42501';
  end if;
  if p ? 'vendor_id' and not exists (select 1 from public.vendors where id = private.j_uuid(p, 'vendor_id', true, 'Vendor') and is_active) then
    raise exception 'Choose an active vendor.' using errcode = '22023';
  end if;
  if p ? 'dispatched_on' then
    perform private.check_dispatch_date(private.j_date(p, 'dispatched_on', true, 'Date given to vendor'));
  end if;
  v_commit := private.j_date(p, 'commitment_date', false, 'Vendor committed delivery date');
  if p ? 'commitment_date' then
    if a.original_commitment_date is not null then
      raise exception 'The committed date is already recorded. Use "Revise commitment" so the change is kept in history.' using errcode = '22023';
    end if;
    if v_commit is null then
      raise exception 'Enter the committed delivery date.' using errcode = '22023';
    end if;
  end if;

  perform private.set_audit_context(
    case when p ? 'vendor_id' and private.j_uuid(p, 'vendor_id', true, 'Vendor') <> a.vendor_id then 'job.vendor_corrected'
         when p ? 'commitment_date' then 'job.commitment_recorded'
         else 'job.assignment_updated' end, v_reason);
  update public.job_assignments set
    vendor_id                = case when p ? 'vendor_id' then private.j_uuid(p, 'vendor_id', true, 'Vendor') else vendor_id end,
    dispatched_on            = case when p ? 'dispatched_on' then private.j_date(p, 'dispatched_on', true, 'Date given to vendor') else dispatched_on end,
    qty_sent                 = case when p ? 'qty_sent' then private.j_int(p, 'qty_sent', 'Quantity sent') else qty_sent end,
    amount                   = case when p ? 'amount' then private.j_money(p, 'amount', 'Estimated amount') else amount end,
    original_commitment_date = case when p ? 'commitment_date' then v_commit else original_commitment_date end,
    current_commitment_date  = case when p ? 'commitment_date' then v_commit else current_commitment_date end,
    remarks                  = case when p ? 'remarks' then coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), '') else remarks end
  where id = p_assignment_id
  returning * into a;
  perform private.set_audit_context(null, null);
  return to_jsonb(a);
end;
$$;

-- Cancel the current vendor and (optionally) forward the same job to another vendor. The cancelled assignment
-- is kept unchanged; the new one is linked to it. Reason (code + text) is mandatory.
create or replace function public.cancel_assignment(
  p_assignment_id uuid, p_expected_version integer, p_cancelled_on date, p_reason_code text, p_reason_text text, p_forward jsonb default null
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a public.job_assignments;
  v_new uuid;
  v_forward boolean := coalesce(jsonb_typeof(p_forward) = 'object', false);
begin
  perform private.require_permission('jobs.cancel');
  if v_forward then perform private.require_permission('assignments.change'); end if;
  select * into a from public.job_assignments where id = p_assignment_id for update;
  if not found or not private.can_view_job(a.job_id) then
    raise exception 'Vendor assignment not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(a.version, p_expected_version, 'This vendor assignment');
  if a.state <> 'open' then
    raise exception 'This vendor assignment is already closed.' using errcode = '22023';
  end if;
  if p_cancelled_on is null or p_cancelled_on < a.dispatched_on or p_cancelled_on > private.today_ist() + 1 then
    raise exception 'Cancellation date must be between the date given to the vendor and tomorrow.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.cancel_reason_codes where code = p_reason_code and is_active) then
    raise exception 'Choose a cancellation reason.' using errcode = '22023';
  end if;
  if p_reason_text is null or length(trim(p_reason_text)) < 3 then
    raise exception 'Describe the cancellation reason (at least 3 characters).' using errcode = '22023';
  end if;
  if v_forward then
    if private.j_uuid(p_forward, 'vendor_id', true, 'New vendor') = a.vendor_id then
      raise exception 'Choose a different vendor to forward the job to.' using errcode = '22023';
    end if;
    if private.j_date(p_forward, 'dispatched_on', true, 'Date given to the new vendor') < p_cancelled_on then
      raise exception 'The new vendor cannot receive the job before the previous vendor was cancelled.' using errcode = '22023';
    end if;
  end if;

  perform private.set_audit_context(case when v_forward then 'job.cancelled_and_forwarded' else 'job.cancelled' end, trim(p_reason_text));
  update public.job_assignments
     set state = 'cancelled', cancelled_on = p_cancelled_on, cancel_reason_code = p_reason_code,
         cancel_reason_text = trim(p_reason_text), cancelled_by = auth.uid()
   where id = p_assignment_id;
  if v_forward then
    perform private.set_audit_context('job.forwarded_to_vendor', trim(p_reason_text));
    v_new := private.add_assignment(a.job_id, p_forward, a.qty_sent, a.id);
  end if;
  update public.jobs set updated_at = now() where id = a.job_id;
  perform private.set_audit_context(null, null);
  return jsonb_build_object('cancelled_assignment_id', a.id, 'new_assignment_id', v_new);
end;
$$;

-- Classify a cancellation imported from Excel without a reason (needed for a fair vendor score).
create or replace function public.reclassify_cancellation(p_assignment_id uuid, p_expected_version integer, p_reason_code text, p_reason_text text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare a public.job_assignments;
begin
  perform private.require_permission('jobs.cancel');
  select * into a from public.job_assignments where id = p_assignment_id for update;
  if not found or not private.can_view_job(a.job_id) then
    raise exception 'Vendor assignment not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(a.version, p_expected_version, 'This vendor assignment');
  if a.cancel_reason_code is distinct from 'legacy_unclassified' then
    raise exception 'Only imported cancellations without a recorded reason can be classified.' using errcode = '22023';
  end if;
  if p_reason_code = 'legacy_unclassified' or not exists (select 1 from public.cancel_reason_codes where code = p_reason_code and is_active) then
    raise exception 'Choose a cancellation reason.' using errcode = '22023';
  end if;
  if p_reason_text is null or length(trim(p_reason_text)) < 3 then
    raise exception 'Describe the cancellation reason (at least 3 characters).' using errcode = '22023';
  end if;
  perform private.set_audit_context('job.cancellation_classified', trim(p_reason_text));
  update public.job_assignments set cancel_reason_code = p_reason_code, cancel_reason_text = trim(p_reason_text)
   where id = p_assignment_id returning * into a;
  perform private.set_audit_context(null, null);
  return to_jsonb(a);
end;
$$;

create or replace function public.archive_job(p_job_id uuid, p_expected_version integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.jobs; v_reason text;
begin
  perform private.require_permission('jobs.archive');
  v_reason := private.require_reason(p_reason);
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(v_job.version, p_expected_version, 'This job');
  if v_job.archived_at is not null then
    raise exception 'This job is already archived.' using errcode = '22023';
  end if;
  if exists (select 1 from public.job_assignments where job_id = p_job_id and state = 'open') then
    raise exception 'Cancel the current vendor assignment before archiving the job.' using errcode = '22023';
  end if;
  perform private.set_audit_context('job.archived', v_reason);
  update public.jobs set archived_at = now(), archived_by = auth.uid(), archive_reason = v_reason where id = p_job_id returning * into v_job;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_job);
end;
$$;

-- History of one job for anyone allowed to see the job (the full Activity History needs activity.view).
create or replace function public.job_activity(p_job_id uuid)
returns setof public.activity_log language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_view_job(p_job_id) then
    raise exception 'You do not have permission for this job.' using errcode = '42501';
  end if;
  return query select * from public.activity_log where job_id = p_job_id order by id;
end;
$$;

create or replace function public.search_part_labels(p_query text, p_limit integer default 10)
returns table (part_label text, jobs bigint, last_given date)
language sql stable set search_path = '' as $$
  select j.part_label, count(*), max(a.dispatched_on)
    from public.jobs j
    left join public.job_assignments a on a.job_id = j.id
   where length(trim(coalesce(p_query, ''))) >= 2 and j.part_label ilike '%' || trim(p_query) || '%'
   group by j.part_label
   order by max(a.dispatched_on) desc nulls last, j.part_label
   limit least(greatest(coalesce(p_limit, 10), 1), 50)
$$;

create or replace function public.list_assignable_users()
returns table (id uuid, full_name text, role_label text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.has_permission('jobs.create') or private.has_permission('jobs.edit')) then
    raise exception 'You do not have permission for this list.' using errcode = '42501';
  end if;
  return query
  select p.id, coalesce(nullif(p.full_name, ''), p.email), r.label
    from public.profiles p join public.roles r on r.key = p.role_key
   where p.is_active
   order by r.sort_order desc, lower(coalesce(nullif(p.full_name, ''), p.email));
end;
$$;

-- Records that need attention (imported or entered without full information).
create or replace function public.missing_data_review()
returns table (issue text, job_id uuid, job_no text, part_label text, vendor_name text, assignment_id uuid, assignment_version integer, detail text)
language sql stable set search_path = '' as $$
  select 'quantity_missing', j.id, j.job_no, j.part_label, null::text, null::uuid, null::integer, 'Quantity sent is not specified'
    from public.jobs j where j.qty_sent is null and j.archived_at is null and j.closed_at is null
  union all
  select 'commitment_missing', j.id, j.job_no, j.part_label, v.name, a.id, a.version, 'Vendor committed delivery date is missing'
    from public.job_assignments a join public.jobs j on j.id = a.job_id join public.vendors v on v.id = a.vendor_id
   where a.state = 'open' and a.original_commitment_date is null and j.closed_at is null
  union all
  select 'amount_missing', j.id, j.job_no, j.part_label, v.name, a.id, a.version, 'Estimated amount is missing'
    from public.job_assignments a join public.jobs j on j.id = a.job_id join public.vendors v on v.id = a.vendor_id
   where a.state = 'open' and a.amount is null and j.closed_at is null
  union all
  select 'cancellation_unclassified', j.id, j.job_no, j.part_label, v.name, a.id, a.version, 'Cancelled in Excel without a reason: classify it'
    from public.job_assignments a join public.jobs j on j.id = a.job_id join public.vendors v on v.id = a.vendor_id
   where a.cancel_reason_code = 'legacy_unclassified'
  order by 3
$$;

-- ---------------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------------
-- Payload: name, company_name, contact_person, mobile, wa_country_code, wa_number, email, address, gst_no,
--          payment_terms, remarks, is_active, category_ids[]
create or replace function public.save_vendor(p_vendor_id uuid, p_expected_version integer, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.vendors;
  v_name text := private.j_text(p, 'name', 120, true, 'Vendor name');
  v_cat uuid;
begin
  perform private.require_permission('vendors.manage');
  if exists (select 1 from public.vendors x where lower(trim(x.name)) = lower(v_name) and x.id is distinct from p_vendor_id) then
    raise exception 'A vendor named "%" already exists.', v_name using errcode = '22023';
  end if;
  if p_vendor_id is null then
    perform private.set_audit_context('vendor.created', null);
    insert into public.vendors (vendor_code, name) values ('V-' || lpad(private.next_number('vendor')::text, 4, '0'), v_name) returning * into v;
  else
    select * into v from public.vendors where id = p_vendor_id for update;
    if not found then
      raise exception 'Vendor not found.' using errcode = 'P0002';
    end if;
    perform private.require_version(v.version, p_expected_version, 'This vendor');
    perform private.set_audit_context('vendor.updated', null);
  end if;
  update public.vendors set
    name            = v_name,
    company_name    = coalesce(private.j_text(p, 'company_name', 200, false, 'Company name'), ''),
    contact_person  = coalesce(private.j_text(p, 'contact_person', 120, false, 'Contact person'), ''),
    mobile          = coalesce(private.j_text(p, 'mobile', 20, false, 'Mobile number'), ''),
    wa_country_code = coalesce(private.j_text(p, 'wa_country_code', 5, false, 'WhatsApp country code'), '+91'),
    wa_number       = coalesce(regexp_replace(private.j_text(p, 'wa_number', 20, false, 'WhatsApp number'), '\s', '', 'g'), ''),
    email           = coalesce(lower(private.j_text(p, 'email', 120, false, 'Email')), ''),
    address         = coalesce(private.j_text(p, 'address', 500, false, 'Address'), ''),
    gst_no          = coalesce(upper(private.j_text(p, 'gst_no', 15, false, 'GST number')), ''),
    payment_terms   = coalesce(private.j_text(p, 'payment_terms', 200, false, 'Payment terms'), ''),
    remarks         = coalesce(private.j_text(p, 'remarks', 1000, false, 'Remarks'), ''),
    is_active       = coalesce((p ->> 'is_active')::boolean, is_active)
  where id = v.id
  returning * into v;
  if p ? 'category_ids' then
    if jsonb_typeof(p -> 'category_ids') <> 'array' then
      raise exception 'Categories must be a list.' using errcode = '22023';
    end if;
    delete from public.vendor_categories where vendor_id = v.id
      and work_category_id not in (select (x #>> '{}')::uuid from jsonb_array_elements(p -> 'category_ids') x);
    for v_cat in select (x #>> '{}')::uuid from jsonb_array_elements(p -> 'category_ids') x loop
      if not exists (select 1 from public.work_categories where id = v_cat) then
        raise exception 'Unknown work category.' using errcode = '22023';
      end if;
      insert into public.vendor_categories (vendor_id, work_category_id) values (v.id, v_cat) on conflict do nothing;
    end loop;
  end if;
  perform private.set_audit_context(null, null);
  return to_jsonb(v);
exception when check_violation then
  raise exception 'Please check the vendor details: mobile/WhatsApp numbers must contain only digits, GST number must be 15 characters, email must be valid.'
    using errcode = '22023';
end;
$$;

-- Basic per-vendor counts for the vendor page (the full reliability score arrives in Phase 5).
create or replace function public.vendor_summary(p_vendor_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'assignments', count(a.id),
    'open', count(a.id) filter (where a.state = 'open' and j.closed_at is null),
    'overdue', count(a.id) filter (where a.state = 'open' and j.closed_at is null and a.current_commitment_date < private.today_ist()),
    'completed', count(a.id) filter (where a.state = 'completed' or (j.closed_at is not null and a.state <> 'cancelled')),
    'cancelled_vendor_caused', count(a.id) filter (where a.state = 'cancelled' and r.vendor_related),
    'cancelled_other', count(a.id) filter (where a.state = 'cancelled' and not coalesce(r.vendor_related, false)),
    'business_amount', coalesce(sum(a.amount) filter (where a.state <> 'cancelled'), 0),
    'first_job', min(a.dispatched_on),
    'last_job', max(a.dispatched_on)
  )
  from public.job_assignments a
  join public.jobs j on j.id = a.job_id
  left join public.cancel_reason_codes r on r.code = a.cancel_reason_code
  where a.vendor_id = p_vendor_id and j.archived_at is null
$$;

-- ---------------------------------------------------------------------------
-- Attachments (files in the private "job-files" bucket, path <job_id>/<uuid>__<name>)
-- ---------------------------------------------------------------------------
create or replace function private.path_job_id(p_name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

create or replace function private.file_extension(p_name text)
returns text language sql immutable set search_path = '' as $$
  select case when p_name ~ '\.[A-Za-z0-9]{1,10}$' then lower(substring(p_name from '\.([A-Za-z0-9]{1,10})$')) else '' end
$$;

create or replace function private.attachment_extension_ok(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.file_extension(p_name) <> ''
     and exists (select 1 from public.app_settings s, jsonb_array_elements_text(s.value -> 'allowed_extensions') e
                  where s.key = 'attachments' and e = private.file_extension(p_name))
$$;

create or replace function public.register_attachment(p_job_id uuid, p_storage_path text, p_file_name text, p_assignment_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  o record;
  v_max integer := private.setting_int('attachments', 'max_file_mb', 50);
  v_vendor uuid;
  r public.attachments;
begin
  perform private.require_permission('attachments.upload');
  if not private.can_view_job(p_job_id) then
    raise exception 'You do not have permission for this job.' using errcode = '42501';
  end if;
  if private.path_job_id(p_storage_path) is distinct from p_job_id then
    raise exception 'The file path does not belong to this job.' using errcode = '22023';
  end if;
  select ob.name, (ob.metadata ->> 'size')::bigint as size, ob.metadata ->> 'mimetype' as mime, coalesce(ob.owner_id, ob.owner::text) as owner
    into o from storage.objects ob where ob.bucket_id = 'job-files' and ob.name = p_storage_path;
  if not found or o.owner is distinct from auth.uid()::text then
    raise exception 'Uploaded file not found.' using errcode = '22023';
  end if;
  if not private.attachment_extension_ok(p_file_name) then
    raise exception 'This file type is not allowed (see Settings > Attachments).' using errcode = '22023';
  end if;
  if o.size is null or o.size <= 0 or o.size > v_max::bigint * 1024 * 1024 then
    raise exception 'The file is larger than the % MB limit.', v_max using errcode = '22023';
  end if;
  if p_assignment_id is not null then
    select vendor_id into v_vendor from public.job_assignments where id = p_assignment_id and job_id = p_job_id;
    if not found then
      raise exception 'Vendor assignment not found for this job.' using errcode = '22023';
    end if;
  end if;
  perform private.set_audit_context('attachment.added', null);
  insert into public.attachments (job_id, assignment_id, vendor_id, storage_path, file_name, extension, mime_type, size_bytes)
  values (p_job_id, p_assignment_id, v_vendor, p_storage_path, left(p_file_name, 255), private.file_extension(p_file_name), o.mime, o.size)
  returning * into r;
  perform private.set_audit_context(null, null);
  return to_jsonb(r);
end;
$$;

create or replace function public.archive_attachment(p_attachment_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r public.attachments; v_reason text;
begin
  perform private.require_permission('attachments.archive');
  v_reason := private.require_reason(p_reason);
  select * into r from public.attachments where id = p_attachment_id for update;
  if not found or not private.can_view_job(r.job_id) then
    raise exception 'Attachment not found.' using errcode = 'P0002';
  end if;
  if r.archived_at is not null then
    raise exception 'Already archived.' using errcode = '22023';
  end if;
  perform private.set_audit_context('attachment.archived', v_reason);
  update public.attachments set archived_at = now(), archived_by = auth.uid(), archive_reason = v_reason where id = p_attachment_id returning * into r;
  perform private.set_audit_context(null, null);
  return to_jsonb(r);
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit)
values ('job-files', 'job-files', false, 52428800)
on conflict (id) do nothing;

create policy cess_job_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'job-files'
              and (select private.has_permission('attachments.upload'))
              and private.can_view_job(private.path_job_id(name))
              and private.attachment_extension_ok(name));
create policy cess_job_files_select on storage.objects for select to authenticated
  using (bucket_id = 'job-files'
         and (select private.has_permission('attachments.download'))
         and private.can_view_job(private.path_job_id(name))
         and exists (select 1 from public.attachments a where a.storage_path = name and a.archived_at is null));
-- an uploader may remove their own file only if it was never registered (failed upload clean-up)
create policy cess_job_files_delete_unregistered on storage.objects for delete to authenticated
  using (bucket_id = 'job-files'
         and owner_id = (select auth.uid())::text
         and not exists (select 1 from public.attachments a where a.storage_path = name));

-- ---------------------------------------------------------------------------
-- Excel import (server re-validates everything; dry_run = preview without saving)
-- ---------------------------------------------------------------------------
create or replace function private.vendor_by_name(p_name text, p_create boolean)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v uuid;
begin
  select id into v from public.vendors where lower(trim(name)) = lower(trim(p_name));
  if v is null and p_create then
    insert into public.vendors (vendor_code, name, remarks)
    values ('V-' || lpad(private.next_number('vendor')::text, 4, '0'), trim(p_name), 'Created by Excel import')
    returning id into v;
  end if;
  return v;
end;
$$;

-- One job group: { ref, part_label, category_name, given_by_name, qty_sent, remarks,
--                  assignments: [{ vendor_name, dispatched_on, returned_on, cancelled_on, commitment_date, amount, remarks }] }
create or replace function private.import_one_job(g jsonb, p_batch uuid, p_create_vendors boolean, p_allow_duplicates boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_part text := private.j_text(g, 'part_label', 200, true, 'Part No / Name');
  v_cat uuid;
  v_gb uuid;
  v_qty integer := private.j_int(g, 'qty_sent', 'Quantity');
  v_list jsonb := g -> 'assignments';
  v_n integer;
  a jsonb;
  i integer := 0;
  v_vendor uuid;
  v_given date; v_ret date; v_can date; v_commit date; v_prev_can date;
  v_job uuid; v_job_no text; v_assign uuid; v_prev uuid := null;
  v_warn text[] := '{}';
  v_first_vendor uuid; v_first_date date;
  v_last_state text;
  v_last_ret date;
begin
  select id into v_cat from public.work_categories where lower(trim(name)) = lower(trim(coalesce(g ->> 'category_name', '')));
  if v_cat is null then
    raise exception 'Work category "%" is not in Settings > Work categories.', coalesce(g ->> 'category_name', '') using errcode = '22023';
  end if;
  if nullif(trim(coalesce(g ->> 'given_by_name', '')), '') is not null then
    select id into v_gb from public.given_by_names where lower(trim(name)) = lower(trim(g ->> 'given_by_name'));
    if v_gb is null then
      raise exception 'Given By "%" is not in Settings > Given By names.', g ->> 'given_by_name' using errcode = '22023';
    end if;
  end if;
  if jsonb_typeof(v_list) <> 'array' or jsonb_array_length(v_list) = 0 then
    raise exception 'No vendor row.' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(v_list);

  -- validate all vendor rows first
  for a in select * from jsonb_array_elements(v_list) loop
    i := i + 1;
    if nullif(trim(coalesce(a ->> 'vendor_name', '')), '') is null then
      raise exception 'Vendor name is missing.' using errcode = '22023';
    end if;
    if private.vendor_by_name(a ->> 'vendor_name', false) is null and not p_create_vendors then
      raise exception 'Vendor "%" is not in the vendor master. Import vendors first or allow creating missing vendors.', a ->> 'vendor_name' using errcode = '22023';
    end if;
    v_given := private.j_date(a, 'dispatched_on', true, 'Date given to vendor');
    perform private.check_dispatch_date(v_given);
    v_ret := private.j_date(a, 'returned_on', false, 'Date returned');
    v_can := private.j_date(a, 'cancelled_on', false, 'Cancelled on');
    v_commit := private.j_date(a, 'commitment_date', false, 'Committed date');
    perform private.j_money(a, 'amount', 'Amount');
    if v_ret is not null and v_can is not null then
      raise exception 'A row cannot have both a return date and a cancellation date.' using errcode = '22023';
    end if;
    if v_ret is not null and v_ret < v_given then
      raise exception 'Date returned is before the date given to the vendor.' using errcode = '22023';
    end if;
    if v_ret is not null and v_ret > private.today_ist() + 1 then
      raise exception 'Date returned is in the future.' using errcode = '22023';
    end if;
    if v_can is not null and v_can < v_given then
      raise exception 'Cancelled On is before the date given to the vendor.' using errcode = '22023';
    end if;
    if v_commit is not null and v_commit < v_given then
      raise exception 'Committed date is before the date given to the vendor.' using errcode = '22023';
    end if;
    if i < v_n and v_can is null then
      raise exception 'A forwarded row must have a Cancelled On date.' using errcode = '22023';
    end if;
    if i > 1 and v_given < v_prev_can then
      v_warn := array_append(v_warn, format('Row given to %s before the previous vendor was cancelled', a ->> 'vendor_name'));
    end if;
    v_prev_can := v_can;
    if i = 1 then
      v_first_date := v_given;
    end if;
  end loop;

  -- duplicates: same part + first vendor + date already in the system
  v_first_vendor := private.vendor_by_name(v_list -> 0 ->> 'vendor_name', false);
  if not p_allow_duplicates and v_first_vendor is not null and exists (
       select 1 from public.job_assignments x join public.jobs j on j.id = x.job_id
        where lower(trim(j.part_label)) = lower(v_part) and x.vendor_id = v_first_vendor and x.dispatched_on = v_first_date) then
    return jsonb_build_object('status', 'duplicate', 'message', 'Already in the system (same part, vendor and date given)');
  end if;

  v_job_no := 'JOB-' || private.fy_code(v_first_date) || '-' || lpad(private.next_number('job:' || private.fy_code(v_first_date))::text, 4, '0');
  insert into public.jobs (job_no, part_label, qty_sent, category_id, given_by_id, remarks, source, import_batch_id, legacy_ref)
  values (v_job_no, v_part, v_qty, v_cat, v_gb, coalesce(private.j_text(g, 'remarks', 2000, false, 'Remarks'), ''), 'excel_import', p_batch,
          left(coalesce(g ->> 'ref', ''), 100))
  returning id into v_job;

  i := 0;
  for a in select * from jsonb_array_elements(v_list) loop
    i := i + 1;
    v_vendor := private.vendor_by_name(a ->> 'vendor_name', p_create_vendors);
    v_given := private.j_date(a, 'dispatched_on', true, 'Date given to vendor');
    v_ret := private.j_date(a, 'returned_on', false, 'Date returned');
    v_can := private.j_date(a, 'cancelled_on', false, 'Cancelled on');
    v_commit := private.j_date(a, 'commitment_date', false, 'Committed date');
    insert into public.job_assignments
      (job_id, sequence_no, vendor_id, dispatched_on, qty_sent, amount, original_commitment_date, current_commitment_date,
       state, completed_on, cancelled_on, cancel_reason_code, cancel_reason_text, previous_assignment_id, remarks)
    values
      (v_job, i, v_vendor, v_given, v_qty, private.j_money(a, 'amount', 'Amount'), v_commit, v_commit,
       case when v_can is not null then 'cancelled' when v_ret is not null then 'completed' else 'open' end,
       v_ret, v_can,
       case when v_can is not null then 'legacy_unclassified' end,
       case when v_can is not null then 'Cancelled in the Excel tracker; reason not recorded' end,
       v_prev, coalesce(private.j_text(a, 'remarks', 2000, false, 'Remarks'), ''))
    returning id, state into v_assign, v_last_state;
    v_prev := v_assign;
    v_last_ret := v_ret;
    if v_can is not null then
      v_warn := array_append(v_warn, 'Cancellation reason not recorded: classify it in Missing Data Review');
    end if;
    if v_can is null and v_ret is null and v_commit is null then
      v_warn := array_append(v_warn, 'Commitment date missing');
    end if;
  end loop;

  if v_last_state = 'completed' then
    update public.jobs
       set closed_at = now(), closed_on = v_last_ret, closed_by = auth.uid(),
           closed_reason = format('Imported from Excel as completed (returned %s). Quantities and quality inspection were not recorded.', to_char(v_last_ret, 'DD-Mon-YYYY'))
     where id = v_job;
  end if;
  if v_qty is null then
    v_warn := array_append(v_warn, 'Quantity not specified');
  end if;
  return jsonb_build_object('status', 'imported', 'job_no', v_job_no, 'job_id', v_job,
                            'outcome', case v_last_state when 'completed' then 'Completed' when 'cancelled' then 'Cancelled' else 'Pending' end,
                            'warnings', to_jsonb(v_warn));
end;
$$;

create or replace function public.import_jobs(p_file_name text, p_file_sha256 text, p_jobs jsonb, p_options jsonb default '{}')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dry boolean := coalesce((p_options ->> 'dry_run')::boolean, true);
  v_create boolean := coalesce((p_options ->> 'create_missing_vendors')::boolean, false);
  v_dup boolean := coalesce((p_options ->> 'allow_duplicates')::boolean, false);
  v_results jsonb := '[]'::jsonb;
  v_batch uuid;
  g jsonb;
  r jsonb;
  v_imported integer := 0; v_duplicates integer := 0; v_errors integer := 0;
begin
  perform private.require_permission('data.import');
  if jsonb_typeof(p_jobs) <> 'array' then
    raise exception 'Invalid import data.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_jobs) > 5000 then
    raise exception 'Too many jobs in one import (maximum 5,000).' using errcode = '22023';
  end if;
  begin
    insert into public.import_batches (kind, file_name, file_sha256, rows_total)
    values ('jobs', left(coalesce(p_file_name, 'workbook.xlsx'), 255), p_file_sha256, jsonb_array_length(p_jobs))
    returning id into v_batch;
    perform private.set_audit_context('import.job_created', 'Excel import: ' || coalesce(p_file_name, ''));
    for g in select * from jsonb_array_elements(p_jobs) loop
      begin
        r := private.import_one_job(g, v_batch, v_create, v_dup);
      exception when others then
        r := jsonb_build_object('status', 'error', 'message', sqlerrm);
      end;
      r := r || jsonb_build_object('ref', g ->> 'ref', 'part_label', g ->> 'part_label');
      case r ->> 'status'
        when 'imported' then v_imported := v_imported + 1;
        when 'duplicate' then v_duplicates := v_duplicates + 1;
        else v_errors := v_errors + 1;
      end case;
      v_results := v_results || jsonb_build_array(r);
    end loop;
    update public.import_batches set rows_imported = v_imported, rows_skipped = v_duplicates + v_errors, details = v_results where id = v_batch;
    perform private.set_audit_context(null, null);
    if v_dry then
      raise exception using errcode = 'CSDRY', message = 'preview only';
    end if;
    perform private.log_event('data.imported', 'import', 'import_batches', v_batch::text, null,
                              jsonb_build_object('file', p_file_name, 'imported', v_imported, 'duplicates', v_duplicates, 'errors', v_errors), null);
  exception when sqlstate 'CSDRY' then
    v_batch := null; -- preview: everything above was rolled back
  end;
  return jsonb_build_object('dry_run', v_dry, 'batch_id', v_batch, 'imported', v_imported, 'duplicates', v_duplicates, 'errors', v_errors, 'results', v_results);
end;
$$;

-- Vendors: { ref, name, company_name, category_name, address, mobile, email, gst_no, contact_person }
create or replace function public.import_vendors(p_file_name text, p_file_sha256 text, p_vendors jsonb, p_options jsonb default '{}')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dry boolean := coalesce((p_options ->> 'dry_run')::boolean, true);
  v_results jsonb := '[]'::jsonb;
  v_batch uuid;
  g jsonb; r jsonb; v jsonb; v_cat uuid;
  v_imported integer := 0; v_duplicates integer := 0; v_errors integer := 0;
begin
  perform private.require_permission('data.import');
  perform private.require_permission('vendors.manage');
  if jsonb_typeof(p_vendors) <> 'array' or jsonb_array_length(p_vendors) > 2000 then
    raise exception 'Invalid vendor data (maximum 2,000 rows).' using errcode = '22023';
  end if;
  begin
    insert into public.import_batches (kind, file_name, file_sha256, rows_total)
    values ('vendors', left(coalesce(p_file_name, 'workbook.xlsx'), 255), p_file_sha256, jsonb_array_length(p_vendors))
    returning id into v_batch;
    for g in select * from jsonb_array_elements(p_vendors) loop
      begin
        if exists (select 1 from public.vendors where lower(trim(name)) = lower(trim(coalesce(g ->> 'name', '')))) then
          r := jsonb_build_object('status', 'duplicate', 'message', 'Vendor already exists');
        else
          v := public.save_vendor(null, null, jsonb_build_object(
            'name', g ->> 'name', 'company_name', g ->> 'company_name', 'contact_person', g ->> 'contact_person',
            'mobile', regexp_replace(coalesce(g ->> 'mobile', ''), '[^0-9+ ()-]', '', 'g'),
            'email', g ->> 'email', 'address', g ->> 'address', 'gst_no', g ->> 'gst_no', 'remarks', 'Imported from Excel'));
          select id into v_cat from public.work_categories where lower(trim(name)) = lower(trim(coalesce(g ->> 'category_name', '')));
          if v_cat is not null then
            insert into public.vendor_categories (vendor_id, work_category_id) values ((v ->> 'id')::uuid, v_cat) on conflict do nothing;
            r := jsonb_build_object('status', 'imported', 'vendor_code', v ->> 'vendor_code');
          else
            r := jsonb_build_object('status', 'imported', 'vendor_code', v ->> 'vendor_code',
                                    'warnings', case when nullif(trim(coalesce(g ->> 'category_name', '')), '') is null then '[]'::jsonb
                                                     else jsonb_build_array(format('Category "%s" not found; not linked', g ->> 'category_name')) end);
          end if;
        end if;
      exception when others then
        r := jsonb_build_object('status', 'error', 'message', sqlerrm);
      end;
      r := r || jsonb_build_object('ref', g ->> 'ref', 'name', g ->> 'name');
      case r ->> 'status'
        when 'imported' then v_imported := v_imported + 1;
        when 'duplicate' then v_duplicates := v_duplicates + 1;
        else v_errors := v_errors + 1;
      end case;
      v_results := v_results || jsonb_build_array(r);
    end loop;
    update public.import_batches set rows_imported = v_imported, rows_skipped = v_duplicates + v_errors, details = v_results where id = v_batch;
    if v_dry then
      raise exception using errcode = 'CSDRY', message = 'preview only';
    end if;
    perform private.log_event('data.imported', 'import', 'import_batches', v_batch::text, null,
                              jsonb_build_object('file', p_file_name, 'vendors_imported', v_imported, 'duplicates', v_duplicates, 'errors', v_errors), null);
  exception when sqlstate 'CSDRY' then
    v_batch := null;
  end;
  return jsonb_build_object('dry_run', v_dry, 'batch_id', v_batch, 'imported', v_imported, 'duplicates', v_duplicates, 'errors', v_errors, 'results', v_results);
end;
$$;

-- client-reported events: attachment download
create or replace function public.log_activity(
  p_action text, p_module text, p_entity_id text default null, p_details jsonb default null, p_reason text default null
) returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_details is not null and length(p_details::text) > 8000 then
    raise exception 'Activity details are too large.' using errcode = '22023';
  end if;
  if p_action in ('auth.signed_in', 'auth.signed_out', 'mfa.enrolled', 'mfa.verified', 'mfa.removed', 'password.changed') then
    if auth.uid() is null or not private.session_ok()
       or not exists (select 1 from public.profiles where id = auth.uid()) then
      raise exception 'Not signed in.' using errcode = '42501';
    end if;
    p_module := 'auth';
  elsif p_action in ('data.exported', 'report.downloaded', 'whatsapp.initiated', 'attachment.downloaded') then
    if not private.is_active_user() then
      raise exception 'Not signed in.' using errcode = '42501';
    end if;
  elsif p_action in ('user.invite_link_generated', 'user.recovery_link_generated', 'user.invite_email_sent', 'user.recovery_email_sent') then
    perform private.require_permission('users.manage');
    p_module := 'users';
  else
    raise exception 'Unknown activity type "%".', p_action using errcode = '22023';
  end if;
  perform private.log_event(p_action, coalesce(nullif(p_module, ''), 'app'), null, p_entity_id, null, p_details, p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security and grants
-- ---------------------------------------------------------------------------
alter table public.number_counters   enable row level security;
alter table public.vendors           enable row level security;
alter table public.vendor_categories enable row level security;
alter table public.import_batches    enable row level security;
alter table public.jobs              enable row level security;
alter table public.job_assignments   enable row level security;
alter table public.attachments       enable row level security;

revoke all on public.number_counters, public.vendors, public.vendor_categories, public.import_batches,
              public.jobs, public.job_assignments, public.attachments, public.job_register
  from anon, authenticated;
grant select on public.vendors, public.vendor_categories, public.import_batches, public.jobs,
                public.job_assignments, public.attachments, public.job_register
  to authenticated;

create policy vendors_read on public.vendors for select to authenticated using ((select private.has_permission('vendors.view')));
create policy vendor_categories_read on public.vendor_categories for select to authenticated using ((select private.has_permission('vendors.view')));
create policy import_batches_read on public.import_batches for select to authenticated using ((select private.has_permission('data.import')));
-- permission checks are wrapped in (select ...) so they run once per query, not once per row
create policy jobs_read on public.jobs for select to authenticated using (
  (select private.has_permission('jobs.view_all'))
  or ((select private.has_permission('jobs.view_assigned'))
      and (assigned_staff_id = (select auth.uid()) or created_by = (select auth.uid()))));
create policy job_assignments_read on public.job_assignments for select to authenticated using (
  (select private.has_permission('jobs.view_all'))
  or exists (select 1 from public.jobs j where j.id = job_id));  -- jobs RLS above decides
create policy attachments_read on public.attachments for select to authenticated using (
  (select private.has_permission('jobs.view_all'))
  or exists (select 1 from public.jobs j where j.id = job_id));

revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.create_job(jsonb), public.update_job(uuid, integer, jsonb, text), public.send_job_to_vendor(uuid, integer, jsonb),
  public.update_assignment(uuid, integer, jsonb, text), public.cancel_assignment(uuid, integer, date, text, text, jsonb),
  public.reclassify_cancellation(uuid, integer, text, text), public.archive_job(uuid, integer, text),
  public.job_activity(uuid), public.search_part_labels(text, integer), public.list_assignable_users(),
  public.missing_data_review(), public.save_vendor(uuid, integer, jsonb), public.vendor_summary(uuid),
  public.register_attachment(uuid, text, text, uuid), public.archive_attachment(uuid, text),
  public.import_jobs(text, text, jsonb, jsonb), public.import_vendors(text, text, jsonb, jsonb),
  public.log_activity(text, text, text, jsonb, text)
to authenticated;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
revoke execute on function private.bootstrap_first_admin(text) from authenticated, service_role;
revoke execute on function private.revoke_user_sessions(uuid) from authenticated, service_role;
revoke execute on function private.log_event(text, text, text, text, jsonb, jsonb, text) from authenticated, service_role;
revoke execute on function private.add_assignment(uuid, jsonb, integer, uuid) from authenticated, service_role;
revoke execute on function private.next_number(text) from authenticated, service_role;
revoke execute on function private.import_one_job(jsonb, uuid, boolean, boolean) from authenticated, service_role;
revoke execute on function private.vendor_by_name(text, boolean) from authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.vendors, public.jobs, public.job_assignments, public.attachments;
  end if;
end;
$$;
