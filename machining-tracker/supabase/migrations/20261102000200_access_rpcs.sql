-- =====================================================================================
-- CESS Machining Job Tracker - Phase 3: access-control RPCs, settings validation, system health
-- Every function here checks permissions itself (SECURITY DEFINER + private.require_permission),
-- so calling the REST API directly gives exactly the same result as using the app.
-- Error codes: 42501 -> HTTP 403 (forbidden), 22023 -> 400 (invalid value), PT409 -> 409 (edit conflict)
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create or replace function private.log_event(
  p_action text, p_module text, p_entity_table text, p_entity_id text,
  p_previous jsonb, p_new jsonb, p_reason text
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_name text; v_role text;
begin
  select coalesce(nullif(p.full_name, ''), p.email), p.role_key into v_name, v_role
    from public.profiles p where p.id = auth.uid();
  insert into public.activity_log
    (actor_id, actor_name, actor_role, source, action, module, entity_table, entity_id,
     previous_value, new_value, reason, session_id, aal)
  values
    (auth.uid(), v_name, v_role,
     case when auth.uid() is not null then 'app' when v_claims ->> 'role' = 'service_role' then 'service' else 'sql' end,
     p_action, p_module, p_entity_table, p_entity_id, p_previous, p_new, p_reason,
     nullif(v_claims ->> 'session_id', '')::uuid, v_claims ->> 'aal');
end;
$$;

-- Deletes all Auth sessions (and with them the refresh tokens) of a user: immediate logout everywhere.
create or replace function private.revoke_user_sessions(p_user_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_count = row_count;
  delete from public.session_activity where user_id = p_user_id;
  return v_count;
end;
$$;

create or replace function private.conflict(p_what text)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception '% was changed by someone else. Reload and try again.', p_what
    using errcode = 'PT409', hint = 'reload';
end;
$$;

-- JSON validation helpers ----------------------------------------------------
create or replace function private.json_keys_exactly(p_value jsonb, p_keys text[], p_what text)
returns void language plpgsql immutable set search_path = '' as $$
declare v_actual text[];
begin
  select coalesce(array_agg(k order by k), '{}') into v_actual from jsonb_object_keys(p_value) k;
  if v_actual <> (select array_agg(k order by k) from unnest(p_keys) k) then
    raise exception '% must contain exactly these fields: %', p_what, array_to_string(p_keys, ', ')
      using errcode = '22023';
  end if;
end;
$$;

create or replace function private.json_int(p_value jsonb, p_field text, p_min integer, p_max integer, p_what text)
returns integer language plpgsql immutable set search_path = '' as $$
declare v jsonb := p_value -> p_field;
begin
  if v is null or jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
     or (v #>> '{}')::numeric < p_min or (v #>> '{}')::numeric > p_max then
    raise exception '% must be a whole number from % to %.', p_what, p_min, p_max using errcode = '22023';
  end if;
  return (v #>> '{}')::integer;
end;
$$;

create or replace function private.json_bool(p_value jsonb, p_field text, p_what text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_value -> p_field) is distinct from 'boolean' then
    raise exception '% must be true or false.', p_what using errcode = '22023';
  end if;
  return (p_value ->> p_field)::boolean;
end;
$$;

create or replace function private.json_text(p_value jsonb, p_field text, p_max integer, p_what text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_value -> p_field) is distinct from 'string' or length(p_value ->> p_field) > p_max then
    raise exception '% must be text of at most % characters.', p_what, p_max using errcode = '22023';
  end if;
  return p_value ->> p_field;
end;
$$;

create or replace function private.json_time(p_value jsonb, p_field text, p_what text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := p_value ->> p_field;
begin
  if jsonb_typeof(p_value -> p_field) is distinct from 'string' or v !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception '% must be a time in HH:MM (24-hour) format.', p_what using errcode = '22023';
  end if;
  return v;
end;
$$;

-- Validates every settings document. Mirrors packages/shared/src/settings.ts (Zod).
create or replace function private.validate_setting(p_key text, p_value jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare
  w jsonb; l jsonb; v_sum numeric := 0; k text; x jsonb; v_idle integer; v_hours integer;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'Setting value must be an object.' using errcode = '22023';
  end if;

  case p_key
  when 'company' then
    perform private.json_keys_exactly(p_value, array['name', 'address', 'gstin', 'phone', 'email'], 'Company information');
    perform private.json_text(p_value, 'name', 120, 'Company name');
    perform private.json_text(p_value, 'address', 500, 'Address');
    perform private.json_text(p_value, 'phone', 30, 'Phone');
    perform private.json_text(p_value, 'email', 120, 'Email');
    if private.json_text(p_value, 'gstin', 15, 'GSTIN') !~ '^$|^[0-9]{2}[A-Z0-9]{13}$' then
      raise exception 'GSTIN must be 15 characters (2 digits followed by 13 capital letters/digits) or empty.' using errcode = '22023';
    end if;
    if (p_value ->> 'email') !~ '^$|^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Email address is not valid.' using errcode = '22023';
    end if;

  when 'localization' then
    perform private.json_keys_exactly(p_value, array['currency', 'timezone', 'date_format', 'fy_start_month'], 'Localization');
    if p_value ->> 'currency' <> 'INR' then
      raise exception 'Currency is fixed to INR.' using errcode = '22023';
    end if;
    if p_value ->> 'timezone' <> 'Asia/Kolkata' then
      raise exception 'Timezone is fixed to Asia/Kolkata so that all dates are calculated consistently.' using errcode = '22023';
    end if;
    if coalesce(p_value ->> 'date_format', '') not in ('dd-MMM-yyyy', 'dd/MM/yyyy', 'dd-MM-yyyy', 'yyyy-MM-dd') then
      raise exception 'Date format must be one of dd-MMM-yyyy, dd/MM/yyyy, dd-MM-yyyy, yyyy-MM-dd.' using errcode = '22023';
    end if;
    if private.json_int(p_value, 'fy_start_month', 1, 12, 'Financial year start month') <> 4 then
      raise exception 'The financial year is April to March (start month 4).' using errcode = '22023';
    end if;

  when 'security' then
    perform private.json_keys_exactly(p_value, array['idle_timeout_minutes', 'max_session_hours'], 'Session security');
    v_idle  := private.json_int(p_value, 'idle_timeout_minutes', 5, 240, 'Idle timeout (minutes)');
    v_hours := private.json_int(p_value, 'max_session_hours', 1, 72, 'Maximum session length (hours)');
    if v_hours * 60 < v_idle then
      raise exception 'Maximum session length must be longer than the idle timeout.' using errcode = '22023';
    end if;

  when 'jobs' then
    perform private.json_keys_exactly(p_value, array['due_soon_days', 'long_pending_days'], 'Job thresholds');
    perform private.json_int(p_value, 'due_soon_days', 1, 30, 'Due soon (days)');
    perform private.json_int(p_value, 'long_pending_days', 1, 365, 'Long pending alert (days)');

  when 'reliability' then
    perform private.json_keys_exactly(p_value,
      array['weights', 'min_eligible_jobs', 'min_factors', 'delay_cap_days', 'stability_revisions_cap', 'labels'], 'Reliability settings');
    w := p_value -> 'weights';
    if jsonb_typeof(w) <> 'object' then
      raise exception 'Weights must be an object.' using errcode = '22023';
    end if;
    perform private.json_keys_exactly(w,
      array['on_time', 'quality', 'delay', 'stability', 'completion_time', 'vendor_cancellation'], 'Weights');
    for k, x in select * from jsonb_each(w) loop
      if jsonb_typeof(x) <> 'number' or (x #>> '{}')::numeric < 0 or (x #>> '{}')::numeric > 100 then
        raise exception 'Weight % must be a number from 0 to 100.', k using errcode = '22023';
      end if;
      v_sum := v_sum + (x #>> '{}')::numeric;
    end loop;
    if v_sum <> 100 then
      raise exception 'Reliability weights must add up to exactly 100 (currently %).', v_sum using errcode = '22023';
    end if;
    perform private.json_int(p_value, 'min_eligible_jobs', 1, 100, 'Minimum eligible jobs');
    perform private.json_int(p_value, 'min_factors', 1, 6, 'Minimum factors with data');
    perform private.json_int(p_value, 'delay_cap_days', 1, 365, 'Delay cap (days)');
    perform private.json_int(p_value, 'stability_revisions_cap', 1, 10, 'Revisions cap');
    l := p_value -> 'labels';
    if jsonb_typeof(l) <> 'object' then
      raise exception 'Labels must be an object.' using errcode = '22023';
    end if;
    perform private.json_keys_exactly(l, array['excellent', 'good', 'average'], 'Score labels');
    if not (private.json_int(l, 'excellent', 1, 100, 'Excellent threshold')
            > private.json_int(l, 'good', 1, 100, 'Good threshold')
            and private.json_int(l, 'good', 1, 100, 'Good threshold')
            > private.json_int(l, 'average', 0, 100, 'Average threshold')) then
      raise exception 'Score thresholds must be Excellent > Good > Average.' using errcode = '22023';
    end if;

  when 'reminders' then
    perform private.json_keys_exactly(p_value,
      array['enabled', 'days_before', 'on_due_date', 'overdue_after_days', 'repeat_daily_when_overdue', 'run_time_ist', 'whatsapp_auto'],
      'Reminder settings');
    perform private.json_bool(p_value, 'enabled', 'Reminders enabled');
    perform private.json_bool(p_value, 'on_due_date', 'Reminder on due date');
    perform private.json_bool(p_value, 'repeat_daily_when_overdue', 'Repeat daily when overdue');
    perform private.json_int(p_value, 'overdue_after_days', 1, 30, 'First overdue reminder (days)');
    perform private.json_time(p_value, 'run_time_ist', 'Reminder time');
    if jsonb_typeof(p_value -> 'days_before') <> 'array' or jsonb_array_length(p_value -> 'days_before') > 5 then
      raise exception 'Days before must be a list of up to 5 numbers.' using errcode = '22023';
    end if;
    for x in select * from jsonb_array_elements(p_value -> 'days_before') loop
      if jsonb_typeof(x) <> 'number' or (x #>> '{}')::numeric not between 1 and 30
         or (x #>> '{}')::numeric <> trunc((x #>> '{}')::numeric) then
        raise exception 'Each "days before" value must be a whole number from 1 to 30.' using errcode = '22023';
      end if;
    end loop;
    if private.json_bool(p_value, 'whatsapp_auto', 'Automatic WhatsApp') then
      raise exception 'Automatic WhatsApp sending needs the WhatsApp Business API, which is not configured.' using errcode = '22023';
    end if;

  when 'weekly_report' then
    perform private.json_keys_exactly(p_value, array['enabled', 'weekday', 'run_time_ist', 'email_delivery'], 'Weekly report settings');
    perform private.json_bool(p_value, 'enabled', 'Weekly report enabled');
    perform private.json_int(p_value, 'weekday', 1, 7, 'Report weekday (1 = Monday)');
    perform private.json_time(p_value, 'run_time_ist', 'Report time');
    if private.json_bool(p_value, 'email_delivery', 'Email delivery') then
      raise exception 'Email delivery needs an email provider, which is not configured.' using errcode = '22023';
    end if;

  when 'attachments' then
    perform private.json_keys_exactly(p_value, array['max_file_mb', 'allowed_extensions'], 'Attachment settings');
    perform private.json_int(p_value, 'max_file_mb', 1, 50, 'Maximum file size (MB, Supabase Free allows 50)');
    if jsonb_typeof(p_value -> 'allowed_extensions') <> 'array' or jsonb_array_length(p_value -> 'allowed_extensions') = 0 then
      raise exception 'Allowed extensions must be a non-empty list.' using errcode = '22023';
    end if;
    for x in select * from jsonb_array_elements(p_value -> 'allowed_extensions') loop
      if jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[a-z0-9]{1,10}$' then
        raise exception 'Extensions must be lower-case letters/digits without a dot.' using errcode = '22023';
      end if;
      if (x #>> '{}') in ('exe', 'bat', 'cmd', 'com', 'msi', 'js', 'vbs', 'ps1', 'scr', 'html', 'htm', 'svg') then
        raise exception 'Extension "%" is not allowed for security reasons.', x #>> '{}' using errcode = '22023';
      end if;
    end loop;

  when 'whatsapp' then
    perform private.json_keys_exactly(p_value, array['default_country_code', 'mode'], 'WhatsApp settings');
    if coalesce(p_value ->> 'default_country_code', '') !~ '^\+[0-9]{1,4}$' then
      raise exception 'Country code must look like +91.' using errcode = '22023';
    end if;
    if p_value ->> 'mode' <> 'click_to_chat' then
      raise exception 'Only click-to-chat is available until the WhatsApp Business API is configured.' using errcode = '22023';
    end if;

  else
    raise exception 'Unknown setting "%".', p_key using errcode = '22023';
  end case;
end;
$$;

-- ---------------------------------------------------------------------------
-- Session / identity RPCs (any signed-in user)
-- ---------------------------------------------------------------------------

-- What the signed-in user may do. Works before MFA so the app can route to MFA enrolment/verification.
create or replace function public.my_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_aal text := coalesce(auth.jwt() ->> 'aal', '');
  v_profile public.profiles;
  v_role public.roles;
  v_session boolean;
  v_perms jsonb := '[]'::jsonb;
  v_status text;
begin
  if v_uid is null then
    return jsonb_build_object('status', 'anonymous');
  end if;
  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    return jsonb_build_object('status', 'no_profile');
  end if;
  select * into v_role from public.roles where key = v_profile.role_key;
  v_session := private.session_ok();
  v_status := case
    when not v_profile.is_active then 'inactive'
    when not v_session then 'session_expired'
    when private.mfa_needed(v_uid) and v_aal <> 'aal2' then 'mfa_required'
    else 'ok' end;
  if v_status = 'ok' then
    select coalesce(jsonb_agg(p.key order by p.sort_order), '[]'::jsonb) into v_perms
      from public.permissions p where private.has_permission(p.key);
  end if;
  return jsonb_build_object(
    'status', v_status,
    'user_id', v_profile.id,
    'email', v_profile.email,
    'full_name', v_profile.full_name,
    'role_key', v_profile.role_key,
    'role_label', v_role.label,
    'mfa_required', v_role.mfa_required,
    'mfa_enrolled', exists (select 1 from auth.mfa_factors f where f.user_id = v_uid and f.status = 'verified'),
    'aal', v_aal,
    'profile_version', v_profile.version,
    'permissions', v_perms,
    'idle_timeout_minutes', private.setting_int('security', 'idle_timeout_minutes', 30),
    'max_session_hours', private.setting_int('security', 'max_session_hours', 12)
  );
end;
$$;

create or replace function public.has_permission(p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission(p_key)
$$;

-- Heartbeat for the server-side idle timeout. Returns false (and ends the session) when it has expired.
create or replace function public.touch_session()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  if auth.uid() is null or v_sid is null then
    return false;
  end if;
  if not private.session_ok() then
    delete from auth.sessions where id = v_sid and user_id = auth.uid();
    delete from public.session_activity where session_id = v_sid;
    return false;
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then
    return false;
  end if;
  insert into public.session_activity (session_id, user_id, last_seen_at)
  values (v_sid, auth.uid(), now())
  on conflict (session_id) do update set last_seen_at = excluded.last_seen_at;
  return true;
end;
$$;

create or replace function public.update_my_profile(p_full_name text, p_expected_version integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_profile public.profiles;
begin
  if not private.is_active_user() then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_full_name is null or length(trim(p_full_name)) not between 1 and 120 then
    raise exception 'Name must be 1 to 120 characters.' using errcode = '22023';
  end if;
  select * into v_profile from public.profiles where id = auth.uid() for update;
  if v_profile.version <> p_expected_version then
    perform private.conflict('Your profile');
  end if;
  perform private.set_audit_context('user.profile_updated', null);
  update public.profiles set full_name = trim(p_full_name) where id = auth.uid() returning * into v_profile;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_profile);
end;
$$;

-- Client-reported events that have no database write of their own (exports, sign-in, WhatsApp opened...).
create or replace function public.log_activity(
  p_action text, p_module text, p_entity_id text default null, p_details jsonb default null, p_reason text default null
) returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_details is not null and length(p_details::text) > 8000 then
    raise exception 'Activity details are too large.' using errcode = '22023';
  end if;
  if p_action in ('auth.signed_in', 'auth.signed_out', 'mfa.enrolled', 'mfa.verified', 'mfa.removed', 'password.changed') then
    -- allowed before MFA is complete, but only with a live session of an existing profile
    if auth.uid() is null or not private.session_ok()
       or not exists (select 1 from public.profiles where id = auth.uid()) then
      raise exception 'Not signed in.' using errcode = '42501';
    end if;
    p_module := 'auth';
  elsif p_action in ('data.exported', 'report.downloaded', 'whatsapp.initiated') then
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
-- Settings
-- ---------------------------------------------------------------------------
create or replace function public.update_setting(p_key text, p_value jsonb, p_expected_version integer)
returns public.app_settings language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.app_settings;
begin
  if p_key = 'security' then
    perform private.require_permission('users.manage');   -- session security is Admin-only
  else
    perform private.require_permission('settings.change');
  end if;
  perform private.validate_setting(p_key, p_value);
  select * into v_row from public.app_settings where key = p_key for update;
  if not found then
    raise exception 'Unknown setting "%".', p_key using errcode = '22023';
  end if;
  if v_row.version <> p_expected_version then
    perform private.conflict('This setting');
  end if;
  perform private.set_audit_context('settings.changed', null);
  update public.app_settings set value = p_value where key = p_key returning * into v_row;
  perform private.set_audit_context(null, null);
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- User administration (Admin only: users.manage is admin_only)
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_users()
returns table (
  id uuid, email text, full_name text, role_key text, is_active boolean, version integer,
  created_at timestamptz, deactivated_at timestamptz, deactivation_reason text,
  last_sign_in_at timestamptz, email_confirmed_at timestamptz, invited_at timestamptz,
  mfa_enabled boolean, active_sessions integer, override_count integer
) language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_permission('users.manage');
  return query
  select p.id, p.email, p.full_name, p.role_key, p.is_active, p.version,
         p.created_at, p.deactivated_at, p.deactivation_reason,
         u.last_sign_in_at, u.email_confirmed_at, u.invited_at,
         exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified'),
         (select count(*)::integer from auth.sessions s where s.user_id = p.id and (s.not_after is null or s.not_after > now())),
         (select count(*)::integer from public.user_permission_overrides o where o.user_id = p.id)
    from public.profiles p
    join auth.users u on u.id = p.id
   order by p.is_active desc, p.role_key, lower(coalesce(nullif(p.full_name, ''), p.email));
end;
$$;

-- Called by the admin-users Edge Function right after it created the Auth user for an invitation.
create or replace function public.admin_finalize_invite(p_user_id uuid, p_full_name text, p_role_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_profile public.profiles;
begin
  perform private.require_permission('users.manage');
  if not exists (select 1 from public.roles where key = p_role_key) then
    raise exception 'Unknown role "%".', p_role_key using errcode = '22023';
  end if;
  if p_full_name is null or length(trim(p_full_name)) not between 1 and 120 then
    raise exception 'Name must be 1 to 120 characters.' using errcode = '22023';
  end if;
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'User not found.' using errcode = 'P0002';
  end if;
  if exists (select 1 from auth.users u where u.id = p_user_id and u.last_sign_in_at is not null) then
    raise exception 'This user has already signed in; edit the user instead.' using errcode = '22023';
  end if;
  perform private.set_audit_context('user.invited', 'Invited as ' || p_role_key);
  update public.profiles
     set full_name = trim(p_full_name), role_key = p_role_key, is_active = true,
         created_by = auth.uid(), deactivated_at = null, deactivated_by = null, deactivation_reason = null
   where id = p_user_id
  returning * into v_profile;
  update auth.users set banned_until = null where id = p_user_id;
  perform private.set_audit_context(null, null);
  return to_jsonb(v_profile);
end;
$$;

create or replace function public.admin_update_user(
  p_user_id uuid, p_expected_version integer,
  p_full_name text default null, p_role_key text default null, p_is_active boolean default null,
  p_reason text default null
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_profile public.profiles;
  v_reason text;
begin
  perform private.require_permission('users.manage');
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'User not found.' using errcode = 'P0002';
  end if;
  if v_profile.version <> p_expected_version then
    perform private.conflict('This user');
  end if;

  if p_full_name is not null and trim(p_full_name) is distinct from v_profile.full_name then
    if length(trim(p_full_name)) not between 1 and 120 then
      raise exception 'Name must be 1 to 120 characters.' using errcode = '22023';
    end if;
    perform private.set_audit_context('user.updated', p_reason);
    update public.profiles set full_name = trim(p_full_name) where id = p_user_id;
  end if;

  if p_role_key is not null and p_role_key <> v_profile.role_key then
    v_reason := private.require_reason(p_reason);
    if p_user_id = auth.uid() then
      raise exception 'You cannot change your own role.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.roles where key = p_role_key) then
      raise exception 'Unknown role "%".', p_role_key using errcode = '22023';
    end if;
    perform private.set_audit_context('user.role_changed', v_reason);
    update public.profiles set role_key = p_role_key where id = p_user_id;
    perform private.revoke_user_sessions(p_user_id);  -- new role = new sign-in (and MFA if required)
  end if;

  if p_is_active is not null and p_is_active <> v_profile.is_active then
    v_reason := private.require_reason(p_reason);
    if not p_is_active then
      if p_user_id = auth.uid() then
        raise exception 'You cannot deactivate your own account.' using errcode = '42501';
      end if;
      perform private.set_audit_context('user.deactivated', v_reason);
      update public.profiles
         set is_active = false, deactivated_at = now(), deactivated_by = auth.uid(), deactivation_reason = v_reason
       where id = p_user_id;
      update auth.users set banned_until = now() + interval '100 years' where id = p_user_id;
      perform private.revoke_user_sessions(p_user_id);
    else
      perform private.set_audit_context('user.reactivated', v_reason);
      update public.profiles
         set is_active = true, deactivated_at = null, deactivated_by = null, deactivation_reason = null
       where id = p_user_id;
      update auth.users set banned_until = null where id = p_user_id;
    end if;
  end if;

  perform private.set_audit_context(null, null);
  select * into v_profile from public.profiles where id = p_user_id;
  return to_jsonb(v_profile);
end;
$$;

create or replace function public.admin_revoke_sessions(p_user_id uuid, p_reason text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_count integer; v_reason text;
begin
  perform private.require_permission('users.manage');
  v_reason := private.require_reason(p_reason);
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'User not found.' using errcode = 'P0002';
  end if;
  v_count := private.revoke_user_sessions(p_user_id);
  perform private.log_event('user.sessions_revoked', 'users', 'profiles', p_user_id::text, null,
                            jsonb_build_object('sessions_ended', v_count), v_reason);
  return v_count;
end;
$$;

create or replace function public.admin_set_role_permission(
  p_role_key text, p_permission_key text, p_granted boolean, p_reason text
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_reason text; v_admin_only boolean;
begin
  perform private.require_permission('users.manage');
  v_reason := private.require_reason(p_reason);
  if p_role_key = 'admin' then
    raise exception 'Admin always has every permission.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.roles where key = p_role_key) then
    raise exception 'Unknown role "%".', p_role_key using errcode = '22023';
  end if;
  select admin_only into v_admin_only from public.permissions where key = p_permission_key;
  if not found then
    raise exception 'Unknown permission "%".', p_permission_key using errcode = '22023';
  end if;
  if v_admin_only and p_granted then
    raise exception 'Permission "%" is reserved for Admin.', p_permission_key using errcode = '42501';
  end if;
  perform private.set_audit_context(case when p_granted then 'permission.granted' else 'permission.revoked' end, v_reason);
  if p_granted then
    insert into public.role_permissions (role_key, permission_key, granted_by)
    values (p_role_key, p_permission_key, auth.uid()) on conflict do nothing;
  else
    delete from public.role_permissions where role_key = p_role_key and permission_key = p_permission_key;
  end if;
  perform private.set_audit_context(null, null);
end;
$$;

-- p_granted: true = grant, false = deny, null = remove the override (back to role default)
create or replace function public.admin_set_user_permission(
  p_user_id uuid, p_permission_key text, p_granted boolean, p_reason text
) returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_reason text; v_admin_only boolean; v_role text;
begin
  perform private.require_permission('users.manage');
  v_reason := private.require_reason(p_reason);
  select role_key into v_role from public.profiles where id = p_user_id;
  if not found then
    raise exception 'User not found.' using errcode = 'P0002';
  end if;
  if v_role = 'admin' then
    raise exception 'Admin always has every permission.' using errcode = '22023';
  end if;
  select admin_only into v_admin_only from public.permissions where key = p_permission_key;
  if not found then
    raise exception 'Unknown permission "%".', p_permission_key using errcode = '22023';
  end if;
  if v_admin_only and coalesce(p_granted, false) then
    raise exception 'Permission "%" is reserved for Admin.', p_permission_key using errcode = '42501';
  end if;
  perform private.set_audit_context(
    case when p_granted is null then 'permission.override_removed'
         when p_granted then 'permission.user_granted' else 'permission.user_denied' end, v_reason);
  if p_granted is null then
    delete from public.user_permission_overrides where user_id = p_user_id and permission_key = p_permission_key;
  else
    insert into public.user_permission_overrides (user_id, permission_key, granted, reason, created_by)
    values (p_user_id, p_permission_key, p_granted, v_reason, auth.uid())
    on conflict (user_id, permission_key)
    do update set granted = excluded.granted, reason = excluded.reason, created_by = excluded.created_by, created_at = now();
  end if;
  perform private.set_audit_context(null, null);
end;
$$;

create or replace function public.admin_set_role_mfa(p_role_key text, p_required boolean, p_reason text, p_expected_version integer)
returns public.roles language plpgsql volatile security definer set search_path = '' as $$
declare v_role public.roles; v_reason text;
begin
  perform private.require_permission('users.manage');
  v_reason := private.require_reason(p_reason);
  select * into v_role from public.roles where key = p_role_key for update;
  if not found then
    raise exception 'Unknown role "%".', p_role_key using errcode = '22023';
  end if;
  if v_role.version <> p_expected_version then
    perform private.conflict('This role');
  end if;
  if p_role_key in ('admin', 'manager') and not p_required then
    raise exception 'MFA is mandatory for Admin and Manager.' using errcode = '22023';
  end if;
  perform private.set_audit_context('role.mfa_policy_changed', v_reason);
  update public.roles set mfa_required = p_required where key = p_role_key returning * into v_role;
  perform private.set_audit_context(null, null);
  return v_role;
end;
$$;

-- Authoritative Supabase Auth events (sign-in, logout, password recovery, ...).
create or replace function public.admin_auth_events(p_limit integer default 100)
returns table (occurred_at timestamptz, action text, actor_id text, actor_email text, ip_address text, log_type text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_permission('users.manage');
  return query
  select e.created_at, e.payload ->> 'action', e.payload ->> 'actor_id', e.payload ->> 'actor_username',
         e.ip_address::text, e.payload ->> 'log_type'
    from auth.audit_log_entries e
   order by e.created_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- ---------------------------------------------------------------------------
-- System health (real values only)
-- ---------------------------------------------------------------------------
create or replace function public.system_health()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_tables jsonb; v_storage_bytes bigint := 0; v_storage_objects bigint := 0; v_schema text;
  v_last_ok jsonb; v_last_fail jsonb;
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
    'last_failed_backup', v_last_fail
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- First Admin bootstrap (run ONCE from the Supabase SQL editor; not callable through the API)
-- ---------------------------------------------------------------------------
create or replace function private.bootstrap_first_admin(p_email text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  if exists (select 1 from public.profiles where role_key = 'admin' and is_active) then
    raise exception 'An active Admin already exists. Manage users from the app instead.' using errcode = '42501';
  end if;
  select id into v_id from public.profiles where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'No account with email %. Create it first in Authentication > Users > Add user (with "Auto Confirm User").', p_email
      using errcode = 'P0002';
  end if;
  perform private.set_audit_context('user.bootstrap_admin', 'First Admin created from the SQL editor');
  update public.profiles set role_key = 'admin', is_active = true where id = v_id;
  update auth.users set banned_until = null where id = v_id;
  perform private.set_audit_context(null, null);
  return 'OK: ' || p_email || ' is now the Admin. Sign in to the app; you will be asked to set up MFA.';
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.my_access(), public.has_permission(text), public.touch_session(),
  public.update_my_profile(text, integer), public.log_activity(text, text, text, jsonb, text),
  public.update_setting(text, jsonb, integer),
  public.admin_list_users(), public.admin_finalize_invite(uuid, text, text),
  public.admin_update_user(uuid, integer, text, text, boolean, text),
  public.admin_revoke_sessions(uuid, text), public.admin_set_role_permission(text, text, boolean, text),
  public.admin_set_user_permission(uuid, text, boolean, text), public.admin_set_role_mfa(text, boolean, text, integer),
  public.admin_auth_events(integer), public.system_health()
to authenticated;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
-- ...except the bootstrap, which only the database owner (SQL editor) may run
revoke execute on function private.bootstrap_first_admin(text) from authenticated, service_role;
revoke execute on function private.revoke_user_sessions(uuid) from authenticated, service_role;
revoke execute on function private.log_event(text, text, text, text, jsonb, jsonb, text) from authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Realtime: notify open browsers when shared configuration changes (RLS still applies)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.app_settings, public.work_categories, public.given_by_names, public.cancel_reason_codes,
      public.roles, public.role_permissions, public.profiles, public.user_permission_overrides;
  end if;
end;
$$;
