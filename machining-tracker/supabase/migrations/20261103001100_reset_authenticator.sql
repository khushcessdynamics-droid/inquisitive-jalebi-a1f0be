-- Admin: reset a person's authenticator (lost or replaced phone). Removes their authenticator app registration and signs them
-- out everywhere; at their next sign-in the app makes them set up a new one (mandatory for Admin and Manager). Needs
-- users.manage (Admin with a verified MFA session), a reason, and is recorded in the activity history. An Admin cannot reset
-- their own here (another Admin does it, or the Supabase SQL editor for the last Admin: docs/ADMIN_SECURITY_GUIDE.md).

create or replace function public.admin_reset_mfa(p_user_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_reason text; v_factors integer; v_sessions integer;
begin
  perform private.require_permission('users.manage');
  v_reason := private.require_reason(p_reason);
  if p_user_id = auth.uid() then
    raise exception 'You cannot reset your own authenticator. Ask another Admin to do it.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'User not found.' using errcode = 'P0002';
  end if;
  delete from auth.mfa_factors where user_id = p_user_id;
  get diagnostics v_factors = row_count;
  if v_factors = 0 then
    raise exception 'This person has no authenticator app set up.' using errcode = '22023';
  end if;
  v_sessions := private.revoke_user_sessions(p_user_id);
  perform private.log_event('user.mfa_reset', 'users', 'profiles', p_user_id::text, null,
                            jsonb_build_object('authenticators_removed', v_factors, 'sessions_ended', v_sessions), v_reason);
  return jsonb_build_object('authenticators_removed', v_factors, 'sessions_ended', v_sessions);
end;
$$;

revoke execute on function public.admin_reset_mfa(uuid, text) from public, anon;
grant execute on function public.admin_reset_mfa(uuid, text) to authenticated;
