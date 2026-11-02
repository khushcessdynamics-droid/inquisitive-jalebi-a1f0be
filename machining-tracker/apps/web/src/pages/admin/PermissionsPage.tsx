import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Lock, Minus } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { useRealtimeInvalidate } from "../../hooks/data";
import { Alert, Badge, PageHeader, ReasonDialog, Spinner, Table, td, th } from "../../components/ui";

interface RoleRow {
  key: string;
  label: string;
  description: string;
  mfa_required: boolean;
  sort_order: number;
  version: number;
}
interface PermissionRow {
  key: string;
  module: string;
  label: string;
  description: string;
  admin_only: boolean;
  sort_order: number;
}

const MODULE_LABELS: Record<string, string> = {
  jobs: "Jobs",
  vendors: "Vendors",
  quality: "Material return & quality",
  payments: "Payments",
  communication: "Communication",
  attachments: "Attachments",
  reports: "Reports",
  admin: "Administration",
};

export function PermissionsPage() {
  const queryClient = useQueryClient();
  useRealtimeInvalidate(["role_permissions", "roles"], ["permission-matrix"]);
  const matrix = useQuery({
    queryKey: ["permission-matrix"],
    queryFn: async () => {
      const [roles, perms, grants] = await Promise.all([
        supabase.from("roles").select("*").order("sort_order"),
        supabase.from("permissions").select("*").order("sort_order"),
        supabase.from("role_permissions").select("role_key,permission_key"),
      ]);
      return {
        roles: unwrap(roles) as RoleRow[],
        perms: unwrap(perms) as PermissionRow[],
        grants: new Set((unwrap(grants) as Array<{ role_key: string; permission_key: string }>).map((g) => `${g.role_key}:${g.permission_key}`)),
      };
    },
  });
  const [pending, setPending] = useState<{ role: RoleRow; perm: PermissionRow; grant: boolean } | null>(null);
  const [mfaPending, setMfaPending] = useState<RoleRow | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["permission-matrix"] });
    await queryClient.invalidateQueries({ queryKey: ["access"] });
  };

  if (matrix.isLoading) return <Spinner />;
  if (matrix.error) return <Alert tone="error">{toAppError(matrix.error).message}</Alert>;
  const { roles, perms, grants } = matrix.data!;
  const modules = [...new Set(perms.map((p) => p.module))];

  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        description="Defaults for each role. The server checks these on every request; hiding a menu item is never the only protection."
      />
      <Table>
        <thead>
          <tr>
            <th className={th}>Permission</th>
            {roles.map((r) => (
              <th key={r.key} className={`${th} text-center`}>
                {r.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          <tr className="bg-brand-50/40">
            <td className={td}>
              <p className="font-medium">Two-factor authentication (MFA)</p>
              <p className="text-xs text-slate-500">Mandatory for Admin and Manager. Optional for Staff unless switched on here.</p>
            </td>
            {roles.map((r) => (
              <td key={r.key} className={`${td} text-center`}>
                {r.key === "admin" || r.key === "manager" ? (
                  <Badge tone="green">
                    <Lock className="mr-1 h-3 w-3" /> Required
                  </Badge>
                ) : (
                  <button type="button" onClick={() => setMfaPending(r)} className="cursor-pointer" aria-label={`Change MFA policy for ${r.label}`}>
                    {r.mfa_required ? <Badge tone="green">Required</Badge> : <Badge>Optional</Badge>}
                  </button>
                )}
              </td>
            ))}
          </tr>
          {modules.map((m) => (
            <Fragment key={m}>
              <tr>
                <td colSpan={roles.length + 1} className="bg-slate-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {MODULE_LABELS[m] ?? m}
                </td>
              </tr>
              {perms
                .filter((p) => p.module === m)
                .map((p) => (
                  <tr key={p.key}>
                    <td className={td}>
                      <p>{p.label}</p>
                      {p.description && <p className="text-xs text-slate-500">{p.description}</p>}
                    </td>
                    {roles.map((r) => {
                      if (r.key === "admin") {
                        return (
                          <td key={r.key} className={`${td} text-center`}>
                            <Check className="mx-auto h-4 w-4 text-emerald-600" aria-label="Always allowed" />
                          </td>
                        );
                      }
                      if (p.admin_only) {
                        return (
                          <td key={r.key} className={`${td} text-center`}>
                            <Lock className="mx-auto h-4 w-4 text-slate-300" aria-label="Admin only" />
                          </td>
                        );
                      }
                      const granted = grants.has(`${r.key}:${p.key}`);
                      return (
                        <td key={r.key} className={`${td} text-center`}>
                          <button
                            type="button"
                            onClick={() => setPending({ role: r, perm: p, grant: !granted })}
                            aria-label={`${granted ? "Revoke" : "Grant"} ${p.label} for ${r.label}`}
                            aria-pressed={granted}
                            className={
                              granted
                                ? "inline-flex h-6 w-6 items-center justify-center rounded bg-emerald-600 text-white hover:bg-emerald-700"
                                : "inline-flex h-6 w-6 items-center justify-center rounded border border-slate-300 text-slate-300 hover:border-slate-400"
                            }
                          >
                            {granted ? <Check className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </Table>

      <ReasonDialog
        open={!!pending}
        title={pending?.grant ? "Grant permission" : "Revoke permission"}
        message={
          <>
            {pending?.grant ? "Allow" : "Stop allowing"} <strong>{pending?.role.label}</strong> to <strong>{pending?.perm.label.toLowerCase()}</strong>. This
            applies to every user with this role (except their personal exceptions) immediately.
          </>
        }
        confirmLabel={pending?.grant ? "Grant" : "Revoke"}
        danger={!pending?.grant}
        onCancel={() => setPending(null)}
        onConfirm={async (reason) => {
          unwrap(
            await supabase.rpc("admin_set_role_permission", {
              p_role_key: pending!.role.key,
              p_permission_key: pending!.perm.key,
              p_granted: pending!.grant,
              p_reason: reason,
            }),
          );
          setPending(null);
          await refresh();
        }}
      />
      <ReasonDialog
        open={!!mfaPending}
        title={mfaPending?.mfa_required ? "Make MFA optional?" : "Require MFA?"}
        message={
          mfaPending?.mfa_required
            ? `${mfaPending?.label} users will be able to sign in with a password only (unless they set up an authenticator themselves).`
            : `${mfaPending?.label} users without an authenticator app will have to set one up the next time they use the app.`
        }
        confirmLabel="Save"
        onCancel={() => setMfaPending(null)}
        onConfirm={async (reason) => {
          unwrap(
            await supabase.rpc("admin_set_role_mfa", {
              p_role_key: mfaPending!.key,
              p_required: !mfaPending!.mfa_required,
              p_reason: reason,
              p_expected_version: mfaPending!.version,
            }),
          );
          setMfaPending(null);
          await refresh();
        }}
      />
    </>
  );
}
