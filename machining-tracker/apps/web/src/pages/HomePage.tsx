import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle } from "lucide-react";
import { formatDateTimeIST, todayIST, formatDate, financialYear } from "@cess/shared";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { unwrap } from "../lib/errors";
import { useDateFormat, useSettings } from "../hooks/data";
import { Badge, Card, PageHeader } from "../components/ui";
import { Dashboard, MyJobsSummary } from "./DashboardPage";

interface Health {
  last_verified_backup: { finished_at: string } | null;
}

function CheckItem({ done, children, to }: { done: boolean; children: string; to: string }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span className="flex items-center gap-2 text-sm text-slate-800">
        {done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-slate-400" />}
        {children}
      </span>
      {!done && (
        <Link to={to} className="text-sm font-medium text-brand-700 hover:underline">
          Open
        </Link>
      )}
    </li>
  );
}

export function HomePage() {
  const { access, can } = useAuth();
  const dateFormat = useDateFormat();
  const settings = useSettings();
  const isAdmin = can("users.manage");
  const users = useQuery({
    queryKey: ["admin-users"],
    enabled: isAdmin,
    queryFn: async () => unwrap(await supabase.rpc("admin_list_users")) as Array<{ id: string }>,
  });
  const health = useQuery({
    queryKey: ["system-health"],
    enabled: can("system.view"),
    queryFn: async () => unwrap(await supabase.rpc("system_health")) as Health,
  });
  const today = todayIST();
  const companyName = (settings.data?.company?.value as { name?: string } | undefined)?.name ?? "";

  return (
    <>
      <PageHeader
        title={`Welcome${access?.full_name ? `, ${access.full_name}` : ""}`}
        description={`${companyName || "CESS"} · ${formatDate(today, dateFormat)} · Financial year ${financialYear(today).label}`}
      />
      <p className="-mt-3 mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <Badge tone="blue">{access?.role_label}</Badge>
        Two-factor: {access?.aal === "aal2" ? <Badge tone="green">On (verified this session)</Badge> : <Badge tone="amber">Not used this session</Badge>}
        <span>· automatic sign-out after {access?.idle_timeout_minutes} minutes without activity</span>
      </p>
      {isAdmin && !(companyName && (users.data?.length ?? 0) > 1 && health.data?.last_verified_backup) && (
        <Card title="Setup checklist" className="mb-4">
          <ul className="divide-y divide-slate-100">
            <CheckItem done={!!companyName} to="/settings">
              Enter company information
            </CheckItem>
            <CheckItem done={(users.data?.length ?? 0) > 1} to="/admin/users">
              Invite Managers and Staff
            </CheckItem>
            <CheckItem done={!!health.data?.last_verified_backup} to="/system">
              Run and verify the first backup
            </CheckItem>
          </ul>
          {health.data?.last_verified_backup && (
            <p className="mt-2 text-xs text-slate-500">Last verified backup: {formatDateTimeIST(health.data.last_verified_backup.finished_at, dateFormat)}</p>
          )}
        </Card>
      )}
      {!access?.mfa_required && access?.aal !== "aal2" && (
        <p className="mb-4 text-sm text-slate-600">
          Two-factor authentication is optional for your role but recommended.{" "}
          <Link to="/mfa?setup=1" className="font-medium text-brand-700 hover:underline">
            Set it up
          </Link>
        </p>
      )}
      {can("reports.view") ? <Dashboard /> : <MyJobsSummary dateFormat={dateFormat} />}
    </>
  );
}
