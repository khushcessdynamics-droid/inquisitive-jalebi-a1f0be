import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { KeyRound, LogOut, MoreHorizontal, Pencil, ShieldCheck, UserCheck, UserPlus, UserX } from "lucide-react";
import { formatDateTimeIST, type RoleKey } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import type { AdminUserRow } from "../../lib/types";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { Alert, Badge, Button, CopyButton, EmptyState, Field, Input, Modal, PageHeader, ReasonDialog, Select, Spinner, Table, td, th } from "../../components/ui";

interface RoleRow {
  key: RoleKey;
  label: string;
  mfa_required: boolean;
  sort_order: number;
}
interface PermissionRow {
  key: string;
  module: string;
  label: string;
  admin_only: boolean;
  sort_order: number;
}

async function callAdminUsers(body: Record<string, unknown>): Promise<{ user_id: string; delivery: string; link?: string }> {
  const { data, error } = await supabase.functions.invoke("admin-users", { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = (await error.context.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? "The request failed.");
    }
    throw new Error(error.message);
  }
  return data as { user_id: string; delivery: string; link?: string };
}

function statusBadge(u: AdminUserRow) {
  if (!u.is_active) return <Badge tone="red">Deactivated</Badge>;
  if (!u.last_sign_in_at) return <Badge tone="amber">Invited</Badge>;
  return <Badge tone="green">Active</Badge>;
}

export function UsersPage() {
  const { access } = useAuth();
  const dateFormat = useDateFormat();
  const queryClient = useQueryClient();
  useRealtimeInvalidate(["profiles"], ["admin-users"]);

  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => unwrap(await supabase.rpc("admin_list_users")) as AdminUserRow[],
  });
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: async () => unwrap(await supabase.from("roles").select("key,label,mfa_required,sort_order").order("sort_order")) as RoleRow[],
  });
  const roleLabel = useMemo(() => Object.fromEntries((roles.data ?? []).map((r) => [r.key, r.label])), [roles.data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin-users"] });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [linkResult, setLinkResult] = useState<{ title: string; email: string; link?: string; emailed: boolean } | null>(null);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);
  const [toggling, setToggling] = useState<AdminUserRow | null>(null);
  const [revoking, setRevoking] = useState<AdminUserRow | null>(null);
  const [resetting, setResetting] = useState<AdminUserRow | null>(null);
  const [overridesFor, setOverridesFor] = useState<AdminUserRow | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Users"
        description="Every person has their own account. Accounts are created by invitation only; deactivated users lose access immediately."
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="h-4 w-4" /> Invite user
          </Button>
        }
      />
      {users.isLoading ? (
        <Spinner />
      ) : users.error ? (
        <Alert tone="error">{toAppError(users.error).message}</Alert>
      ) : !users.data?.length ? (
        <EmptyState title="No users yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Role</th>
              <th className={th}>Status</th>
              <th className={th}>MFA</th>
              <th className={th}>Last sign-in</th>
              <th className={th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {users.data.map((u) => (
              <tr key={u.id}>
                <td className={td}>
                  <p className="font-medium">{u.full_name || "—"}</p>
                  <p className="text-xs text-slate-500">{u.email}</p>
                  {u.override_count > 0 && <p className="text-xs text-brand-700">{u.override_count} permission exception(s)</p>}
                </td>
                <td className={td}>{roleLabel[u.role_key] ?? u.role_key}</td>
                <td className={td}>
                  {statusBadge(u)}
                  {!u.is_active && u.deactivation_reason && <p className="mt-1 max-w-48 text-xs text-slate-500">{u.deactivation_reason}</p>}
                </td>
                <td className={td}>{u.mfa_enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}</td>
                <td className={td}>
                  <span className="whitespace-nowrap text-xs">{u.last_sign_in_at ? formatDateTimeIST(u.last_sign_in_at, dateFormat) : "Never"}</span>
                  {u.active_sessions > 0 && <p className="text-xs text-slate-500">{u.active_sessions} live session(s)</p>}
                </td>
                <td className={`${td} relative text-right`}>
                  <Button variant="ghost" aria-label={`Actions for ${u.email}`} onClick={() => setMenuFor(menuFor === u.id ? null : u.id)}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                  {menuFor === u.id && (
                    <div className="absolute right-3 z-10 mt-1 w-56 rounded-md border border-slate-200 bg-white py-1 text-left shadow-lg" onMouseLeave={() => setMenuFor(null)}>
                      {[
                        { label: "Edit name / role", icon: Pencil, onClick: () => setEditing(u), show: true },
                        { label: "Permission exceptions", icon: ShieldCheck, onClick: () => setOverridesFor(u), show: u.role_key !== "admin" },
                        { label: "Password reset link", icon: KeyRound, onClick: () => setResetting(u), show: u.is_active },
                        { label: "End all sessions", icon: LogOut, onClick: () => setRevoking(u), show: u.active_sessions > 0 },
                        { label: u.is_active ? "Deactivate" : "Reactivate", icon: u.is_active ? UserX : UserCheck, onClick: () => setToggling(u), show: u.id !== access?.user_id },
                      ]
                        .filter((a) => a.show)
                        .map((a) => (
                          <button
                            key={a.label}
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                            onClick={() => {
                              setMenuFor(null);
                              a.onClick();
                            }}
                          >
                            <a.icon className="h-4 w-4" /> {a.label}
                          </button>
                        ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <InviteDialog
        open={inviteOpen}
        roles={roles.data ?? []}
        onClose={() => setInviteOpen(false)}
        onDone={(result) => {
          setInviteOpen(false);
          setLinkResult(result);
          void refresh();
        }}
      />

      <Modal open={!!linkResult} title={linkResult?.title ?? ""} onClose={() => setLinkResult(null)} footer={<Button onClick={() => setLinkResult(null)}>Done</Button>}>
        {linkResult?.emailed ? (
          <Alert tone="success">An email was sent to {linkResult.email}. If it does not arrive, create a link instead.</Alert>
        ) : (
          <>
            <Alert tone="warning" title="Share this link only with the person it is for">
              Anyone with the link can set the password for <strong>{linkResult?.email}</strong>. It works once and expires (Supabase Auth link
              expiry setting). It is not stored anywhere and will not be shown again.
            </Alert>
            <Input readOnly value={linkResult?.link ?? ""} onFocus={(e) => e.currentTarget.select()} aria-label="One-time link" />
            {linkResult?.link && <CopyButton text={linkResult.link} label="Copy link" />}
          </>
        )}
      </Modal>

      <EditUserDialog user={editing} roles={roles.data ?? []} self={editing?.id === access?.user_id} onClose={() => setEditing(null)} onSaved={refresh} />

      <ReasonDialog
        open={!!toggling}
        title={toggling?.is_active ? "Deactivate user?" : "Reactivate user?"}
        message={
          toggling?.is_active
            ? `${toggling.email} will be signed out everywhere immediately and cannot sign in. All history is kept.`
            : `${toggling?.email} will be able to sign in again.`
        }
        confirmLabel={toggling?.is_active ? "Deactivate" : "Reactivate"}
        danger={toggling?.is_active}
        onCancel={() => setToggling(null)}
        onConfirm={async (reason) => {
          unwrap(
            await supabase.rpc("admin_update_user", {
              p_user_id: toggling!.id,
              p_expected_version: toggling!.version,
              p_is_active: !toggling!.is_active,
              p_reason: reason,
            }),
          );
          setToggling(null);
          await refresh();
        }}
      />

      <ReasonDialog
        open={!!revoking}
        title="End all sessions?"
        message={`${revoking?.email} will be signed out on every device immediately.`}
        confirmLabel="End sessions"
        danger
        onCancel={() => setRevoking(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("admin_revoke_sessions", { p_user_id: revoking!.id, p_reason: reason }));
          setRevoking(null);
          await refresh();
        }}
      />

      <ResetDialog
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={(r) => {
          setResetting(null);
          setLinkResult(r);
        }}
      />

      <OverridesDialog user={overridesFor} onClose={() => setOverridesFor(null)} onChanged={refresh} />
    </>
  );
}

function InviteDialog({
  open,
  roles,
  onClose,
  onDone,
}: {
  open: boolean;
  roles: RoleRow[];
  onClose: () => void;
  onDone: (r: { title: string; email: string; link?: string; emailed: boolean }) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleKey>("staff");
  const [delivery, setDelivery] = useState<"link" | "email">("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await callAdminUsers({ action: "invite", email: email.trim(), full_name: fullName.trim(), role_key: role, delivery });
      onDone({ title: "User invited", email: email.trim(), link: r.link, emailed: delivery === "email" });
      setFullName("");
      setEmail("");
      setRole("staff");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const selected = roles.find((r) => r.key === role);
  return (
    <Modal
      open={open}
      title="Invite user"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!fullName.trim() || !emailOk} onClick={submit}>
            {delivery === "link" ? "Create invitation link" : "Send invitation email"}
          </Button>
        </>
      }
    >
      <Field label="Full name" htmlFor="inv-name">
        <Input id="inv-name" value={fullName} maxLength={120} onChange={(e) => setFullName(e.target.value)} />
      </Field>
      <Field label="Email" htmlFor="inv-email">
        <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Role" htmlFor="inv-role" hint={selected?.mfa_required ? "This role must use two-factor authentication." : undefined}>
        <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as RoleKey)}>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium text-slate-700">How should the person get their link?</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="delivery" checked={delivery === "link"} onChange={() => setDelivery("link")} className="mt-1" />
          <span>
            <strong>Copy link</strong> and send it yourself (works without an email service)
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="delivery" checked={delivery === "email"} onChange={() => setDelivery("email")} className="mt-1" />
          <span>
            <strong>Send email</strong> (needs custom SMTP configured in Supabase; the built-in email only reaches your Supabase team)
          </span>
        </label>
      </fieldset>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

function EditUserDialog({ user, roles, self, onClose, onSaved }: { user: AdminUserRow | null; roles: RoleRow[]; self: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<RoleKey>("staff");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (user && loadedFor !== user.id) {
    setLoadedFor(user.id);
    setName(user.full_name);
    setRole(user.role_key);
    setReason("");
    setError(null);
  }
  if (!user && loadedFor) setLoadedFor(null);
  const roleChanged = !!user && role !== user.role_key;

  return (
    <Modal
      open={!!user}
      title="Edit user"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!name.trim() || (roleChanged && reason.trim().length < 3)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                unwrap(
                  await supabase.rpc("admin_update_user", {
                    p_user_id: user!.id,
                    p_expected_version: user!.version,
                    p_full_name: name.trim(),
                    p_role_key: roleChanged ? role : null,
                    p_reason: reason.trim() || null,
                  }),
                );
                onSaved();
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">{user?.email}</p>
      <Field label="Full name" htmlFor="ed-name">
        <Input id="ed-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Role" htmlFor="ed-role" hint={self ? "You cannot change your own role." : roleChanged ? "The user will be signed out and must sign in again." : undefined}>
        <Select id="ed-role" value={role} disabled={self} onChange={(e) => setRole(e.target.value as RoleKey)}>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </Select>
      </Field>
      {roleChanged && (
        <Field label="Reason for role change" htmlFor="ed-reason">
          <Input id="ed-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

function ResetDialog({ user, onClose, onDone }: { user: AdminUserRow | null; onClose: () => void; onDone: (r: { title: string; email: string; link?: string; emailed: boolean }) => void }) {
  const [busy, setBusy] = useState<"link" | "email" | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(delivery: "link" | "email") {
    setBusy(delivery);
    setError(null);
    try {
      const r = await callAdminUsers({ action: "recovery", user_id: user!.id, delivery });
      onDone({ title: "Password reset", email: user!.email, link: r.link, emailed: delivery === "email" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }
  return (
    <Modal open={!!user} title="Password reset" onClose={onClose}>
      <p className="text-sm text-slate-700">
        Create a one-time link that lets <strong>{user?.email}</strong> choose a new password. Their two-factor authentication stays in place.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button loading={busy === "link"} disabled={!!busy} onClick={() => run("link")}>
          Create link
        </Button>
        <Button variant="secondary" loading={busy === "email"} disabled={!!busy} onClick={() => run("email")}>
          Send email
        </Button>
      </div>
    </Modal>
  );
}

function OverridesDialog({ user, onClose, onChanged }: { user: AdminUserRow | null; onClose: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const data = useQuery({
    queryKey: ["user-overrides", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const [perms, rolePerms, overrides] = await Promise.all([
        supabase.from("permissions").select("key,module,label,admin_only,sort_order").order("sort_order"),
        supabase.from("role_permissions").select("permission_key").eq("role_key", user!.role_key),
        supabase.from("user_permission_overrides").select("permission_key,granted,reason").eq("user_id", user!.id),
      ]);
      return {
        perms: unwrap(perms) as PermissionRow[],
        roleSet: new Set((unwrap(rolePerms) as Array<{ permission_key: string }>).map((r) => r.permission_key)),
        overrides: new Map((unwrap(overrides) as Array<{ permission_key: string; granted: boolean; reason: string }>).map((o) => [o.permission_key, o])),
      };
    },
  });
  const [pending, setPending] = useState<{ key: string; label: string; value: boolean | null } | null>(null);

  return (
    <>
      <Modal open={!!user && !pending} title={`Permission exceptions: ${user?.full_name || user?.email}`} onClose={onClose} wide>
        <p className="text-sm text-slate-600">
          Exceptions override the role default for this user only. Admin-only permissions cannot be granted.
        </p>
        {data.isLoading ? (
          <Spinner />
        ) : data.error ? (
          <Alert tone="error">{toAppError(data.error).message}</Alert>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Permission</th>
                <th className={th}>Role default</th>
                <th className={th}>This user</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.data?.perms.map((p) => {
                const o = data.data.overrides.get(p.key);
                const value = o ? (o.granted ? "allow" : "deny") : "default";
                return (
                  <tr key={p.key}>
                    <td className={td}>
                      <p>{p.label}</p>
                      <p className="text-xs text-slate-400">{p.key}</p>
                      {o && <p className="text-xs text-brand-700">Reason: {o.reason}</p>}
                    </td>
                    <td className={td}>{data.data.roleSet.has(p.key) ? <Badge tone="green">Allowed</Badge> : <Badge>Not allowed</Badge>}</td>
                    <td className={td}>
                      <Select
                        aria-label={`Exception for ${p.label}`}
                        value={value}
                        disabled={p.admin_only}
                        onChange={(e) =>
                          setPending({ key: p.key, label: p.label, value: e.target.value === "default" ? null : e.target.value === "allow" })
                        }
                      >
                        <option value="default">Role default</option>
                        <option value="allow">Always allow</option>
                        <option value="deny">Always deny</option>
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Modal>
      <ReasonDialog
        open={!!pending}
        title="Change permission exception"
        message={
          <>
            <strong>{pending?.label}</strong> for {user?.email}:{" "}
            {pending?.value === null ? "back to role default" : pending?.value ? "always allow" : "always deny"}
          </>
        }
        confirmLabel="Save"
        onCancel={() => setPending(null)}
        onConfirm={async (reason) => {
          unwrap(
            await supabase.rpc("admin_set_user_permission", {
              p_user_id: user!.id,
              p_permission_key: pending!.key,
              p_granted: pending!.value,
              p_reason: reason,
            }),
          );
          setPending(null);
          await queryClient.invalidateQueries({ queryKey: ["user-overrides", user?.id] });
          onChanged();
        }}
      />
    </>
  );
}
