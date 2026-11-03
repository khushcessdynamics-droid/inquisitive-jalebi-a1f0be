-- =====================================================================================
-- Phase 5 (part 2): vendor cost comparison. A quotation request is one requirement (part, category, quantity);
-- each vendor's quote is stored against it. The comparison and the recommendation are calculated on every read.
-- The system never assigns a vendor by itself: a person selects the vendor and confirms the job.
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.quotation_requests (
  id                        uuid primary key default gen_random_uuid(),
  request_no                text not null unique,
  part_label                text not null check (length(trim(part_label)) between 1 and 200),
  category_id               uuid not null references public.work_categories (id),
  qty                       integer not null check (qty between 1 and 100000000),
  required_by               date,
  remarks                   text not null default '' check (length(remarks) <= 2000),
  status                    text not null default 'open' check (status in ('open', 'decided', 'job_created', 'closed')),
  selected_quotation_id     uuid,
  recommended_quotation_id  uuid,
  decision_reason           text,
  decided_at                timestamptz,
  decided_by                uuid,
  job_id                    uuid references public.jobs (id),
  closed_reason             text,
  created_at                timestamptz not null default now(),
  created_by                uuid default auth.uid(),
  updated_at                timestamptz not null default now(),
  updated_by                uuid,
  version                   integer not null default 1,
  constraint quotation_request_decided check (status not in ('decided', 'job_created') or selected_quotation_id is not null),
  constraint quotation_request_job check (status <> 'job_created' or job_id is not null),
  constraint quotation_request_closed check (status <> 'closed' or length(trim(coalesce(closed_reason, ''))) >= 3)
);
create index quotation_requests_part_idx on public.quotation_requests (lower(trim(part_label)));

create table public.vendor_quotations (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references public.quotation_requests (id),
  vendor_id       uuid not null references public.vendors (id),
  quote_date      date not null,
  -- the vendor's price is either a per-part rate or one amount for the whole required quantity;
  -- the other figure is calculated (never typed twice)
  basis           text not null check (basis in ('per_part', 'total')),
  price           numeric(14, 2) not null check (price > 0),
  delivery_days   integer check (delivery_days is null or delivery_days between 0 and 365),
  quote_ref       text not null default '' check (length(quote_ref) <= 100),
  remarks         text not null default '' check (length(remarks) <= 2000),
  is_withdrawn    boolean not null default false,
  withdrawn_reason text,
  created_at      timestamptz not null default now(),
  created_by      uuid default auth.uid(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  version         integer not null default 1,
  constraint quotation_withdrawn_reason check (not is_withdrawn or length(trim(coalesce(withdrawn_reason, ''))) >= 3)
);
-- one live quote per vendor per request (a revised quote replaces the figures; the old figures stay in Activity History)
create unique index vendor_quotations_one_per_vendor on public.vendor_quotations (request_id, vendor_id) where not is_withdrawn;
create index vendor_quotations_vendor_idx on public.vendor_quotations (vendor_id);

alter table public.quotation_requests
  add constraint quotation_requests_selected_fk foreign key (selected_quotation_id) references public.vendor_quotations (id),
  add constraint quotation_requests_recommended_fk foreign key (recommended_quotation_id) references public.vendor_quotations (id);

create trigger quotation_requests_version before update on public.quotation_requests for each row execute function private.bump_version();
create trigger vendor_quotations_version before update on public.vendor_quotations for each row execute function private.bump_version();
create trigger quotation_requests_no_delete before delete on public.quotation_requests for each row execute function private.forbid_delete();
create trigger vendor_quotations_no_delete before delete on public.vendor_quotations for each row execute function private.forbid_delete();
create trigger quotation_requests_audit after insert or update or delete on public.quotation_requests
  for each row execute function private.audit_row('id', 'quotations');
create trigger vendor_quotations_audit after insert or update or delete on public.vendor_quotations
  for each row execute function private.audit_row('id', 'quotations');

-- ---------------------------------------------------------------------------
-- 2. Setting: recommendation weights (quality enters through the reliability score, which gives it 25%)
-- ---------------------------------------------------------------------------
select private.set_audit_context('system.seeded', 'Phase 5 reference data (migration 20261103000400)');
insert into public.app_settings (key, label, value) values
  ('cost_comparison', 'Vendor cost comparison',
   '{"weights": {"price": 45, "reliability": 35, "delivery": 20}, "min_quotes": 2, "stale_quote_days": 90}');
select private.set_audit_context(null, null);

alter function private.validate_setting(text, jsonb) rename to validate_setting_base;
create function private.validate_setting(p_key text, p_value jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare w jsonb; k text; x jsonb; v_sum numeric := 0;
begin
  if p_key <> 'cost_comparison' then
    perform private.validate_setting_base(p_key, p_value);
    return;
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'Setting value must be an object.' using errcode = '22023';
  end if;
  perform private.json_keys_exactly(p_value, array['weights', 'min_quotes', 'stale_quote_days'], 'Cost comparison settings');
  w := p_value -> 'weights';
  if jsonb_typeof(w) <> 'object' then
    raise exception 'Weights must be an object.' using errcode = '22023';
  end if;
  perform private.json_keys_exactly(w, array['price', 'reliability', 'delivery'], 'Recommendation weights');
  for k, x in select * from jsonb_each(w) loop
    if jsonb_typeof(x) <> 'number' or (x #>> '{}')::numeric < 0 or (x #>> '{}')::numeric > 100 then
      raise exception 'Weight % must be a number from 0 to 100.', k using errcode = '22023';
    end if;
    v_sum := v_sum + (x #>> '{}')::numeric;
  end loop;
  if v_sum <> 100 then
    raise exception 'Recommendation weights must add up to exactly 100 (currently %).', v_sum using errcode = '22023';
  end if;
  if (w ->> 'price')::numeric = 100 then
    raise exception 'Price cannot carry 100%%: the recommendation must not be based on price alone.' using errcode = '22023';
  end if;
  perform private.json_int(p_value, 'min_quotes', 2, 10, 'Minimum quotations to recommend');
  perform private.json_int(p_value, 'stale_quote_days', 7, 730, 'Quotation age warning (days)');
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Functions: requests and quotes (permission "Add and edit vendor quotations")
-- ---------------------------------------------------------------------------
-- Payload: part_label, category_id, qty, required_by, remarks
create or replace function public.save_quotation_request(p_request_id uuid, p_expected_version integer, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.quotation_requests;
  v_part text := private.j_text(p, 'part_label', 200, true, 'Part No / Part Name');
  v_cat uuid := private.j_uuid(p, 'category_id', true, 'Work category');
  v_qty integer := private.j_int(p, 'qty', 'Required quantity');
  v_req date := private.j_date(p, 'required_by', false, 'Required by');
  v_no text;
begin
  perform private.require_permission('quotations.manage');
  if v_qty is null then
    raise exception 'Required quantity is required: the total cost is calculated for it.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.work_categories where id = v_cat and is_active) then
    raise exception 'Choose an active work category.' using errcode = '22023';
  end if;
  if p_request_id is null then
    v_no := 'QR-' || private.fy_code(private.today_ist()) || '-'
            || lpad(private.next_number('quote:' || private.fy_code(private.today_ist()))::text, 4, '0');
    perform private.set_audit_context('quotation.request_created', null);
    insert into public.quotation_requests (request_no, part_label, category_id, qty, required_by, remarks)
    values (v_no, v_part, v_cat, v_qty, v_req, coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), ''))
    returning * into r;
  else
    select * into r from public.quotation_requests where id = p_request_id for update;
    if not found then
      raise exception 'Quotation request not found.' using errcode = 'P0002';
    end if;
    perform private.require_version(r.version, p_expected_version, 'This quotation request');
    if r.status <> 'open' then
      raise exception 'Only an open request can be changed. Reopen it first.' using errcode = '22023';
    end if;
    perform private.set_audit_context('quotation.request_updated', null);
    update public.quotation_requests set part_label = v_part, category_id = v_cat, qty = v_qty, required_by = v_req,
           remarks = coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), '')
     where id = p_request_id returning * into r;
  end if;
  perform private.set_audit_context(null, null);
  return to_jsonb(r);
end;
$$;

-- Payload: vendor_id, quote_date, basis ('per_part' | 'total'), price, delivery_days, quote_ref, remarks
create or replace function public.save_quotation(p_quotation_id uuid, p_expected_version integer, p_request_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  q public.vendor_quotations;
  r public.quotation_requests;
  v_vendor uuid := private.j_uuid(p, 'vendor_id', true, 'Vendor');
  v_date date := private.j_date(p, 'quote_date', true, 'Quotation date');
  v_basis text := coalesce(p ->> 'basis', '');
  v_price numeric := private.j_money(p, 'price', 'Quoted price');
  v_days integer;
  v_days_raw jsonb := p -> 'delivery_days';
begin
  perform private.require_permission('quotations.manage');
  if p_quotation_id is not null then
    select * into q from public.vendor_quotations where id = p_quotation_id for update;
    if not found then
      raise exception 'Quotation not found.' using errcode = 'P0002';
    end if;
    perform private.require_version(q.version, p_expected_version, 'This quotation');
    if q.is_withdrawn then
      raise exception 'A withdrawn quotation cannot be changed. Add a new one.' using errcode = '22023';
    end if;
    p_request_id := q.request_id;
  end if;
  select * into r from public.quotation_requests where id = p_request_id for update;
  if not found then
    raise exception 'Quotation request not found.' using errcode = 'P0002';
  end if;
  if r.status <> 'open' then
    raise exception 'Quotations can be added or changed only while the request is open.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.vendors where id = v_vendor and is_active) then
    raise exception 'Choose an active vendor.' using errcode = '22023';
  end if;
  if v_basis not in ('per_part', 'total') then
    raise exception 'Choose whether the price is per part or for the whole quantity.' using errcode = '22023';
  end if;
  if v_price is null or v_price <= 0 then
    raise exception 'Enter the quoted price (more than ₹0).' using errcode = '22023';
  end if;
  if v_date < date '2015-01-01' or v_date > private.today_ist() + 1 then
    raise exception 'Quotation date must be between 01-Jan-2015 and tomorrow.' using errcode = '22023';
  end if;
  if v_days_raw is not null and jsonb_typeof(v_days_raw) <> 'null' and coalesce(trim(v_days_raw #>> '{}'), '') <> '' then
    if (v_days_raw #>> '{}') !~ '^\s*\d+\s*$' or (v_days_raw #>> '{}')::numeric > 365 then
      raise exception 'Expected delivery days must be a whole number from 0 to 365.' using errcode = '22023';
    end if;
    v_days := (v_days_raw #>> '{}')::integer;
  end if;
  if exists (select 1 from public.vendor_quotations x
              where x.request_id = r.id and x.vendor_id = v_vendor and not x.is_withdrawn
                and x.id is distinct from p_quotation_id) then
    raise exception 'This vendor already has a quotation on this request. Edit it instead.' using errcode = '22023';
  end if;

  if p_quotation_id is null then
    perform private.set_audit_context('quotation.added', null);
    insert into public.vendor_quotations (request_id, vendor_id, quote_date, basis, price, delivery_days, quote_ref, remarks)
    values (r.id, v_vendor, v_date, v_basis, v_price, v_days,
            coalesce(private.j_text(p, 'quote_ref', 100, false, 'Quotation reference'), ''),
            coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), ''))
    returning * into q;
  else
    perform private.set_audit_context('quotation.updated', null);
    update public.vendor_quotations set vendor_id = v_vendor, quote_date = v_date, basis = v_basis, price = v_price,
           delivery_days = v_days,
           quote_ref = coalesce(private.j_text(p, 'quote_ref', 100, false, 'Quotation reference'), ''),
           remarks = coalesce(private.j_text(p, 'remarks', 2000, false, 'Remarks'), '')
     where id = p_quotation_id returning * into q;
  end if;
  perform private.set_audit_context(null, null);
  return to_jsonb(q);
end;
$$;

create or replace function public.withdraw_quotation(p_quotation_id uuid, p_expected_version integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare q public.vendor_quotations; v_reason text;
begin
  perform private.require_permission('quotations.manage');
  v_reason := private.require_reason(p_reason);
  select * into q from public.vendor_quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'Quotation not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(q.version, p_expected_version, 'This quotation');
  if q.is_withdrawn then
    raise exception 'This quotation is already withdrawn.' using errcode = '22023';
  end if;
  if (select status from public.quotation_requests where id = q.request_id) <> 'open' then
    raise exception 'Quotations can be withdrawn only while the request is open.' using errcode = '22023';
  end if;
  perform private.set_audit_context('quotation.withdrawn', v_reason);
  update public.vendor_quotations set is_withdrawn = true, withdrawn_reason = v_reason where id = q.id returning * into q;
  perform private.set_audit_context(null, null);
  return to_jsonb(q);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Comparison (calculated on every read)
-- ---------------------------------------------------------------------------
-- Per live quote: total for the required quantity, per-part rate, difference from the lowest and from the average,
-- vendor reliability (category score when available, otherwise overall), price/delivery/reliability scores and the
-- weighted "value" score used for the recommendation. A factor is used only when every compared quote has it,
-- so no vendor is ranked on information the others lack.
create or replace function private.quotation_compare(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r public.quotation_requests;
  cfg jsonb := coalesce((select value from public.app_settings where key = 'cost_comparison'),
                        '{"weights": {"price": 45, "reliability": 35, "delivery": 20}, "min_quotes": 2, "stale_quote_days": 90}');
  v_wp numeric := coalesce((cfg -> 'weights' ->> 'price')::numeric, 45);
  v_wr numeric := coalesce((cfg -> 'weights' ->> 'reliability')::numeric, 35);
  v_wd numeric := coalesce((cfg -> 'weights' ->> 'delivery')::numeric, 20);
  v_min integer := coalesce((cfg ->> 'min_quotes')::integer, 2);
  v_stale integer := coalesce((cfg ->> 'stale_quote_days')::integer, 90);
  v_today date := private.today_ist();
  v_quotes jsonb;
  v_n integer;
  v_low numeric; v_high numeric; v_avg numeric;
  v_min_days integer;
  v_use_rel boolean; v_use_del boolean;
  v_missing_rel text; v_missing_del text;
  v_w numeric;
  v_best uuid;
  v_ranked jsonb;
  v_rel_overall jsonb;
  v_rel_cat jsonb;
begin
  select * into r from public.quotation_requests where id = p_request_id;
  if not found then
    raise exception 'Quotation request not found.' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_object_agg(x ->> 'vendor_id', x), '{}'::jsonb) into v_rel_overall
    from private.reliability_scores(null, null, null, null, false) x;
  select coalesce(jsonb_object_agg(x ->> 'vendor_id', x), '{}'::jsonb) into v_rel_cat
    from private.reliability_scores(null, null, r.category_id, null, false) x;

  -- live quotes with calculated figures
  with q as (
    select vq.*, v.name as vendor_name, v.vendor_code,
           case when vq.basis = 'per_part' then round(vq.price * r.qty, 2) else vq.price end as total,
           case when vq.basis = 'per_part' then vq.price else round(vq.price / r.qty, 2) end as per_part,
           v_rel_cat -> (vq.vendor_id::text) as rel_c,
           v_rel_overall -> (vq.vendor_id::text) as rel_o
      from public.vendor_quotations vq
      join public.vendors v on v.id = vq.vendor_id
     where vq.request_id = r.id and not vq.is_withdrawn
  )
  select jsonb_agg(jsonb_build_object(
           'id', q.id, 'version', q.version, 'vendor_id', q.vendor_id, 'vendor_name', q.vendor_name, 'vendor_code', q.vendor_code,
           'quote_date', q.quote_date, 'basis', q.basis, 'price', q.price, 'delivery_days', q.delivery_days,
           'quote_ref', q.quote_ref, 'remarks', q.remarks, 'total', q.total, 'per_part', q.per_part,
           'reliability', case
              when q.rel_c ->> 'score' is not null then jsonb_build_object('score', (q.rel_c ->> 'score')::numeric, 'label', q.rel_c ->> 'label',
                   'basis', 'category', 'eligible_jobs', (q.rel_c ->> 'eligible_jobs')::int)
              when q.rel_o ->> 'score' is not null then jsonb_build_object('score', (q.rel_o ->> 'score')::numeric, 'label', q.rel_o ->> 'label',
                   'basis', 'overall', 'eligible_jobs', (q.rel_o ->> 'eligible_jobs')::int)
              else jsonb_build_object('score', null, 'label', null, 'basis', null,
                   'eligible_jobs', coalesce((q.rel_o ->> 'eligible_jobs')::int, 0),
                   'min_eligible_jobs', private.setting_int('reliability', 'min_eligible_jobs', 5)) end,
           'on_time_pct', coalesce(q.rel_c -> 'measures' -> 'on_time_pct', q.rel_o -> 'measures' -> 'on_time_pct'),
           'stale', v_today - q.quote_date > v_stale,
           'misses_required_date', r.required_by is not null and q.delivery_days is not null and v_today + q.delivery_days > r.required_by
         ) order by q.total, q.delivery_days nulls last, q.vendor_name), count(*), min(q.total), max(q.total), round(avg(q.total), 2),
         min(q.delivery_days)
    into v_quotes, v_n, v_low, v_high, v_avg, v_min_days
    from q;
  v_quotes := coalesce(v_quotes, '[]'::jsonb);

  select string_agg(e ->> 'vendor_name', ', ') into v_missing_rel from jsonb_array_elements(v_quotes) e
   where e -> 'reliability' ->> 'score' is null;
  select string_agg(e ->> 'vendor_name', ', ') into v_missing_del from jsonb_array_elements(v_quotes) e
   where e ->> 'delivery_days' is null;
  v_use_rel := v_n > 0 and v_missing_rel is null and v_wr > 0;
  v_use_del := v_n > 0 and v_missing_del is null and v_wd > 0;
  v_w := v_wp + case when v_use_rel then v_wr else 0 end + case when v_use_del then v_wd else 0 end;

  select jsonb_agg(e || jsonb_build_object(
           'diff_vs_lowest', round((e ->> 'total')::numeric - v_low, 2),
           'diff_vs_lowest_pct', case when v_low > 0 then round(100 * ((e ->> 'total')::numeric - v_low) / v_low, 1) end,
           'diff_vs_average', round((e ->> 'total')::numeric - v_avg, 2),
           'diff_vs_average_pct', case when v_avg > 0 then round(100 * ((e ->> 'total')::numeric - v_avg) / v_avg, 1) end,
           'price_score', round(100 * v_low / (e ->> 'total')::numeric, 1),
           'delivery_score', case when (e ->> 'delivery_days') is not null
                                  then round(100.0 * greatest(v_min_days, 1) / greatest((e ->> 'delivery_days')::int, 1), 1) end,
           'value_score', case when v_n >= v_min then round((
                v_wp * 100 * v_low / (e ->> 'total')::numeric
              + case when v_use_rel then v_wr * (e -> 'reliability' ->> 'score')::numeric else 0 end
              + case when v_use_del then v_wd * 100.0 * greatest(v_min_days, 1) / greatest((e ->> 'delivery_days')::int, 1) else 0 end
              ) / v_w, 1) end,
           'is_lowest', (e ->> 'total')::numeric = v_low,
           'is_highest', (e ->> 'total')::numeric = v_high and v_high <> v_low,
           'is_fastest', (e ->> 'delivery_days') is not null and (e ->> 'delivery_days')::int = v_min_days
         ) order by ord)
    into v_ranked
    from jsonb_array_elements(v_quotes) with ordinality as t(e, ord);
  v_ranked := coalesce(v_ranked, '[]'::jsonb);

  if v_n >= v_min then
    select (e ->> 'id')::uuid into v_best
      from jsonb_array_elements(v_ranked) e
     order by (e ->> 'value_score')::numeric desc, (e ->> 'total')::numeric, (e ->> 'delivery_days')::int nulls last
     limit 1;
  end if;

  return jsonb_build_object(
    'request', to_jsonb(r) || jsonb_build_object(
        'category_name', (select name from public.work_categories where id = r.category_id),
        'job_no', (select job_no from public.jobs where id = r.job_id),
        'decided_by_name', private.user_name(r.decided_by),
        'created_by_name', private.user_name(r.created_by)),
    'settings', cfg,
    'today', v_today,
    'stats', jsonb_build_object(
        'count', v_n, 'lowest', v_low, 'highest', v_high, 'average', v_avg,
        'spread', case when v_n > 0 then v_high - v_low end,
        'spread_pct', case when v_n > 0 and v_low > 0 then round(100 * (v_high - v_low) / v_low, 1) end,
        'lowest_per_part', case when v_n > 0 then round(v_low / r.qty, 2) end,
        'highest_per_part', case when v_n > 0 then round(v_high / r.qty, 2) end,
        'average_per_part', case when v_n > 0 then round(v_avg / r.qty, 2) end),
    'quotes', v_ranked,
    'withdrawn', coalesce((
        select jsonb_agg(jsonb_build_object('id', vq.id, 'vendor_name', v.name, 'quote_date', vq.quote_date, 'basis', vq.basis,
                 'price', vq.price, 'withdrawn_reason', vq.withdrawn_reason) order by vq.updated_at)
          from public.vendor_quotations vq join public.vendors v on v.id = vq.vendor_id
         where vq.request_id = r.id and vq.is_withdrawn), '[]'::jsonb),
    'recommendation', jsonb_build_object(
        'quotation_id', v_best,
        'available', v_best is not null,
        'reason', case when v_n < v_min then format('At least %s quotations are needed for a recommendation (%s so far).', v_min, v_n) end,
        'weights_used', jsonb_build_object(
            'price', round(100 * v_wp / nullif(v_w, 0), 1),
            'reliability', case when v_use_rel then round(100 * v_wr / v_w, 1) else 0 end,
            'delivery', case when v_use_del then round(100 * v_wd / v_w, 1) else 0 end),
        'left_out', to_jsonb(array_remove(array[
            case when not v_use_rel and v_wr > 0 and v_missing_rel is not null
                 then format('Reliability: no score yet for %s (too few completed jobs), so reliability was not used for anyone.', v_missing_rel) end,
            case when not v_use_del and v_wd > 0 and v_missing_del is not null
                 then format('Delivery time: not stated by %s, so delivery time was not used for anyone.', v_missing_del) end], null)),
        'note', 'Quality performance is part of the reliability score (25% of it). The recommendation is advice only: you choose the vendor.'),
    'history', jsonb_build_object(
        -- the same part given to any vendor before (amount = job amount recorded on the vendor assignment)
        'part', coalesce((
            select jsonb_agg(h order by h ->> 'dispatched_on' desc)
              from (select jsonb_build_object('job_id', j.id, 'job_no', j.job_no, 'vendor_id', a.vendor_id, 'vendor_name', v.name,
                             'dispatched_on', a.dispatched_on, 'qty', a.qty_sent, 'amount', a.amount,
                             'per_part', case when a.amount is not null and a.qty_sent is not null then round(a.amount / a.qty_sent, 2) end,
                             'state', a.state, 'completed_on', a.completed_on) as h
                      from public.job_assignments a
                      join public.jobs j on j.id = a.job_id and j.archived_at is null
                      join public.vendors v on v.id = a.vendor_id
                     where lower(trim(j.part_label)) = lower(trim(r.part_label))
                     order by a.dispatched_on desc limit 50) z), '[]'::jsonb),
        -- earlier quotations for the same part
        'part_quotes', coalesce((
            select jsonb_agg(h order by h ->> 'quote_date' desc)
              from (select jsonb_build_object('request_id', qr.id, 'request_no', qr.request_no, 'vendor_name', v.name,
                             'quote_date', vq.quote_date, 'qty', qr.qty,
                             'per_part', case when vq.basis = 'per_part' then vq.price else round(vq.price / qr.qty, 2) end,
                             'total', case when vq.basis = 'per_part' then round(vq.price * qr.qty, 2) else vq.price end,
                             'selected', qr.selected_quotation_id = vq.id) as h
                      from public.vendor_quotations vq
                      join public.quotation_requests qr on qr.id = vq.request_id
                      join public.vendors v on v.id = vq.vendor_id
                     where qr.id <> r.id and not vq.is_withdrawn and lower(trim(qr.part_label)) = lower(trim(r.part_label))
                     order by vq.quote_date desc limit 50) z), '[]'::jsonb),
        -- the quoted vendors' recent jobs in the same machining category (any part)
        'category', coalesce((
            select jsonb_agg(h order by h ->> 'vendor_name', h ->> 'dispatched_on' desc)
              from (select jsonb_build_object('vendor_id', a.vendor_id, 'vendor_name', v.name, 'job_id', j.id, 'job_no', j.job_no,
                             'part_label', j.part_label, 'dispatched_on', a.dispatched_on, 'qty', a.qty_sent, 'amount', a.amount,
                             'per_part', case when a.amount is not null and a.qty_sent is not null then round(a.amount / a.qty_sent, 2) end,
                             'days_taken', case when a.state = 'completed' then a.completed_on - a.dispatched_on end,
                             'state', a.state) as h,
                           row_number() over (partition by a.vendor_id order by a.dispatched_on desc) as rn
                      from public.job_assignments a
                      join public.jobs j on j.id = a.job_id and j.archived_at is null
                      join public.vendors v on v.id = a.vendor_id
                     where j.category_id = r.category_id
                       and a.vendor_id in (select vq.vendor_id from public.vendor_quotations vq where vq.request_id = r.id and not vq.is_withdrawn)
                   ) z where z.rn <= 10), '[]'::jsonb)
    ));
end;
$$;

create or replace function public.quotation_comparison(p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_permission('costcompare.view');
  return private.quotation_compare(p_request_id);
end;
$$;

-- List of requests with quick figures for the Cost Comparison page.
create or replace function public.quotation_requests_list(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_permission('costcompare.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'request_no', r.request_no, 'part_label', r.part_label, 'category_name', c.name, 'qty', r.qty,
             'required_by', r.required_by, 'status', r.status, 'created_at', r.created_at, 'job_id', r.job_id, 'job_no', j.job_no,
             'quotes', (select count(*) from public.vendor_quotations vq where vq.request_id = r.id and not vq.is_withdrawn),
             'lowest', (select min(case when vq.basis = 'per_part' then round(vq.price * r.qty, 2) else vq.price end)
                          from public.vendor_quotations vq where vq.request_id = r.id and not vq.is_withdrawn),
             'selected_vendor', (select v.name from public.vendor_quotations vq join public.vendors v on v.id = vq.vendor_id
                                  where vq.id = r.selected_quotation_id))
           order by r.created_at desc)
      from public.quotation_requests r
      join public.work_categories c on c.id = r.category_id
      left join public.jobs j on j.id = r.job_id
     where p_status is null or r.status = p_status), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Decision and job creation (always a person's choice)
-- ---------------------------------------------------------------------------
-- Records which quote was chosen. A reason is required when the choice differs from the recommendation.
create or replace function public.select_quotation(p_request_id uuid, p_expected_version integer, p_quotation_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.quotation_requests;
  v_cmp jsonb;
  v_rec uuid;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  perform private.require_permission('quotations.manage');
  select * into r from public.quotation_requests where id = p_request_id for update;
  if not found then
    raise exception 'Quotation request not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(r.version, p_expected_version, 'This quotation request');
  if r.status not in ('open', 'decided') then
    raise exception 'The vendor can no longer be changed on this request.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.vendor_quotations where id = p_quotation_id and request_id = r.id and not is_withdrawn) then
    raise exception 'Choose one of the live quotations on this request.' using errcode = '22023';
  end if;
  v_cmp := private.quotation_compare(r.id);
  v_rec := nullif(v_cmp -> 'recommendation' ->> 'quotation_id', '')::uuid;
  if v_rec is not null and v_rec <> p_quotation_id and (v_reason is null or length(v_reason) < 3) then
    raise exception 'You chose a different vendor from the recommendation: please give the reason.' using errcode = '22023';
  end if;
  if v_reason is not null and length(v_reason) > 1000 then
    raise exception 'The reason can have at most 1000 characters.' using errcode = '22023';
  end if;
  perform private.set_audit_context('quotation.vendor_selected', v_reason);
  update public.quotation_requests set status = 'decided', selected_quotation_id = p_quotation_id, recommended_quotation_id = v_rec,
         decision_reason = v_reason, decided_at = now(), decided_by = auth.uid()
   where id = r.id returning * into r;
  perform private.set_audit_context(null, null);
  return to_jsonb(r);
end;
$$;

create or replace function public.reopen_quotation_request(p_request_id uuid, p_expected_version integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r public.quotation_requests; v_reason text;
begin
  perform private.require_permission('quotations.manage');
  v_reason := private.require_reason(p_reason);
  select * into r from public.quotation_requests where id = p_request_id for update;
  if not found then
    raise exception 'Quotation request not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(r.version, p_expected_version, 'This quotation request');
  if r.status not in ('decided', 'closed') then
    raise exception 'Only a decided or closed request can be reopened.' using errcode = '22023';
  end if;
  perform private.set_audit_context('quotation.request_reopened', v_reason);
  update public.quotation_requests set status = 'open', selected_quotation_id = null, recommended_quotation_id = null,
         decision_reason = null, decided_at = null, decided_by = null, closed_reason = null
   where id = r.id returning * into r;
  perform private.set_audit_context(null, null);
  return to_jsonb(r);
end;
$$;

create or replace function public.close_quotation_request(p_request_id uuid, p_expected_version integer, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r public.quotation_requests; v_reason text;
begin
  perform private.require_permission('quotations.manage');
  v_reason := private.require_reason(p_reason);
  select * into r from public.quotation_requests where id = p_request_id for update;
  if not found then
    raise exception 'Quotation request not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(r.version, p_expected_version, 'This quotation request');
  if r.status not in ('open', 'decided') then
    raise exception 'This request is already finished.' using errcode = '22023';
  end if;
  perform private.set_audit_context('quotation.request_closed', v_reason);
  update public.quotation_requests set status = 'closed', closed_reason = v_reason, selected_quotation_id = null,
         recommended_quotation_id = null, decision_reason = null, decided_at = null, decided_by = null
   where id = r.id returning * into r;
  perform private.set_audit_context(null, null);
  return to_jsonb(r);
end;
$$;

-- Creates the job for the selected vendor after the person confirms the details (date given, committed date,
-- Given By, ...). Uses the normal job creation, so the same permissions and checks apply.
-- Payload: given_by_id, assigned_staff_id, description, remarks, dispatched_on, commitment_date
create or replace function public.create_job_from_quotation(p_request_id uuid, p_expected_version integer, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.quotation_requests;
  q public.vendor_quotations;
  v_job jsonb;
  v_total numeric;
begin
  perform private.require_permission('quotations.manage');
  perform private.require_permission('jobs.create');
  select * into r from public.quotation_requests where id = p_request_id for update;
  if not found then
    raise exception 'Quotation request not found.' using errcode = 'P0002';
  end if;
  perform private.require_version(r.version, p_expected_version, 'This quotation request');
  if r.status <> 'decided' then
    raise exception 'Select the vendor first.' using errcode = '22023';
  end if;
  select * into q from public.vendor_quotations where id = r.selected_quotation_id;
  v_total := case when q.basis = 'per_part' then round(q.price * r.qty, 2) else q.price end;
  v_job := public.create_job(jsonb_build_object(
    'part_label', r.part_label, 'category_id', r.category_id, 'qty_sent', r.qty,
    'given_by_id', p -> 'given_by_id', 'assigned_staff_id', p -> 'assigned_staff_id',
    'description', coalesce(p ->> 'description', ''),
    'remarks', coalesce(nullif(p ->> 'remarks', ''), 'From quotation ' || r.request_no),
    'vendor', jsonb_build_object('vendor_id', q.vendor_id, 'dispatched_on', p -> 'dispatched_on', 'qty_sent', r.qty,
                                 'amount', v_total, 'commitment_date', p -> 'commitment_date')));
  perform private.set_audit_context('quotation.job_created', null);
  update public.quotation_requests set status = 'job_created', job_id = (v_job ->> 'id')::uuid where id = r.id returning * into r;
  perform private.set_audit_context(null, null);
  return v_job || jsonb_build_object('request', to_jsonb(r));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Price history: what was paid (job amounts) and quoted for matching parts, per vendor
-- ---------------------------------------------------------------------------
create or replace function public.price_history(p_query text, p_category_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_q text := nullif(trim(coalesce(p_query, '')), '');
begin
  perform private.require_permission('costcompare.view');
  if v_q is null and p_category_id is null then
    raise exception 'Enter part text or choose a category.' using errcode = '22023';
  end if;
  if v_q is not null and length(v_q) < 2 then
    raise exception 'Enter at least 2 characters of the part number or name.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'jobs', coalesce((
      select jsonb_agg(h order by h ->> 'dispatched_on' desc)
        from (select jsonb_build_object('job_id', j.id, 'job_no', j.job_no, 'part_label', j.part_label, 'category_name', c.name,
                       'vendor_id', a.vendor_id, 'vendor_name', v.name, 'dispatched_on', a.dispatched_on, 'qty', a.qty_sent,
                       'amount', a.amount,
                       'per_part', case when a.amount is not null and a.qty_sent is not null then round(a.amount / a.qty_sent, 2) end,
                       'state', a.state) as h
                from public.job_assignments a
                join public.jobs j on j.id = a.job_id and j.archived_at is null
                join public.work_categories c on c.id = j.category_id
                join public.vendors v on v.id = a.vendor_id
               where (v_q is null or j.part_label ilike '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
                 and (p_category_id is null or j.category_id = p_category_id)
                 and a.amount is not null
               order by a.dispatched_on desc limit 300) z), '[]'::jsonb),
    'quotes', coalesce((
      select jsonb_agg(h order by h ->> 'quote_date' desc)
        from (select jsonb_build_object('request_id', qr.id, 'request_no', qr.request_no, 'part_label', qr.part_label, 'category_name', c.name,
                       'vendor_id', vq.vendor_id, 'vendor_name', v.name, 'quote_date', vq.quote_date, 'qty', qr.qty,
                       'per_part', case when vq.basis = 'per_part' then vq.price else round(vq.price / qr.qty, 2) end,
                       'total', case when vq.basis = 'per_part' then round(vq.price * qr.qty, 2) else vq.price end,
                       'selected', qr.selected_quotation_id = vq.id) as h
                from public.vendor_quotations vq
                join public.quotation_requests qr on qr.id = vq.request_id
                join public.work_categories c on c.id = qr.category_id
                join public.vendors v on v.id = vq.vendor_id
               where not vq.is_withdrawn
                 and (v_q is null or qr.part_label ilike '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
                 and (p_category_id is null or qr.category_id = p_category_id)
               order by vq.quote_date desc limit 300) z), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Row Level Security, grants, realtime
-- ---------------------------------------------------------------------------
alter table public.quotation_requests enable row level security;
alter table public.vendor_quotations enable row level security;
revoke all on public.quotation_requests, public.vendor_quotations from anon, authenticated;
grant select on public.quotation_requests, public.vendor_quotations to authenticated;
create policy quotation_requests_read on public.quotation_requests for select to authenticated
  using ((select private.has_permission('costcompare.view')));
create policy vendor_quotations_read on public.vendor_quotations for select to authenticated
  using ((select private.has_permission('costcompare.view')));

revoke execute on function
  public.save_quotation_request(uuid, integer, jsonb), public.save_quotation(uuid, integer, uuid, jsonb),
  public.withdraw_quotation(uuid, integer, text), public.quotation_comparison(uuid), public.quotation_requests_list(text),
  public.select_quotation(uuid, integer, uuid, text), public.reopen_quotation_request(uuid, integer, text),
  public.close_quotation_request(uuid, integer, text), public.create_job_from_quotation(uuid, integer, jsonb),
  public.price_history(text, uuid)
from public, anon;
grant execute on function
  public.save_quotation_request(uuid, integer, jsonb), public.save_quotation(uuid, integer, uuid, jsonb),
  public.withdraw_quotation(uuid, integer, text), public.quotation_comparison(uuid), public.quotation_requests_list(text),
  public.select_quotation(uuid, integer, uuid, text), public.reopen_quotation_request(uuid, integer, text),
  public.close_quotation_request(uuid, integer, text), public.create_job_from_quotation(uuid, integer, jsonb),
  public.price_history(text, uuid)
to authenticated;

revoke execute on function private.quotation_compare(uuid) from public, anon, authenticated, service_role;
revoke execute on function private.validate_setting(text, jsonb) from public, anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.quotation_requests, public.vendor_quotations;
  end if;
end;
$$;
