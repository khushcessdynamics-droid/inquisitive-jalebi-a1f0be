import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDateTimeIST, isIsoDate } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import type { ActivityRow } from "../../lib/types";
import { actionLabel as label } from "../../lib/activity";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, cx, td, th } from "../../components/ui";

const PAGE_SIZE = 50;

function Diff({ row }: { row: ActivityRow }) {
  const keys = [...new Set([...Object.keys(row.previous_value ?? {}), ...Object.keys(row.new_value ?? {})])];
  if (!keys.length) return <p className="text-xs text-slate-500">No field details.</p>;
  const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-slate-500">
          <th className="py-1 pr-3 font-medium">Field</th>
          <th className="py-1 pr-3 font-medium">Before</th>
          <th className="py-1 font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k} className="align-top">
            <td className="py-1 pr-3 font-mono text-slate-600">{k}</td>
            <td className="max-w-xs break-all py-1 pr-3 text-red-700">{show(row.previous_value?.[k])}</td>
            <td className="max-w-xs break-all py-1 text-emerald-700">{show(row.new_value?.[k])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ActivityPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<"history" | "auth">("history");
  return (
    <>
      <PageHeader title="Activity History" description="Append-only record of who changed what and when. Entries cannot be edited or deleted." />
      {can("users.manage") && (
        <div className="mb-4 flex gap-1 border-b border-slate-200" role="tablist">
          {(
            [
              ["history", "Changes & actions"],
              ["auth", "Sign-in events (Supabase Auth)"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cx("border-b-2 px-3 py-2 text-sm font-medium", tab === k ? "border-brand-700 text-brand-700" : "border-transparent text-slate-500")}
            >
              {l}
            </button>
          ))}
        </div>
      )}
      {tab === "history" ? <History /> : <AuthEvents />}
    </>
  );
}

function History() {
  const dateFormat = useDateFormat();
  const [module, setModule] = useState("");
  const [action, setAction] = useState("");
  const [person, setPerson] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const filters = { module, action, person, from, to, page };
  useRealtimeInvalidate(["activity_log"], ["activity"]);

  const q = useQuery({
    queryKey: ["activity", filters],
    queryFn: async () => {
      let query = supabase
        .from("activity_log")
        .select("*", { count: "exact" })
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (module) query = query.eq("module", module);
      if (action.trim()) query = query.ilike("action", `%${action.trim()}%`);
      if (person.trim()) query = query.ilike("actor_name", `%${person.trim()}%`);
      if (from && isIsoDate(from)) query = query.gte("occurred_at", `${from}T00:00:00+05:30`);
      if (to && isIsoDate(to)) query = query.lte("occurred_at", `${to}T23:59:59.999+05:30`);
      const res = await query;
      return { rows: unwrap(res) as ActivityRow[], count: res.count ?? 0 };
    },
  });
  const pages = Math.max(1, Math.ceil((q.data?.count ?? 0) / PAGE_SIZE));

  return (
    <>
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Module" htmlFor="f-mod">
            <Select id="f-mod" value={module} onChange={(e) => { setModule(e.target.value); setPage(0); }}>
              <option value="">All</option>
              <option value="auth">Sign-in & security</option>
              <option value="users">Users & permissions</option>
              <option value="settings">Settings</option>
              <option value="jobs">Jobs</option>
              <option value="vendors">Vendors</option>
              <option value="quotations">Cost comparison</option>
              <option value="payments">Payments</option>
              <option value="attachments">Attachments</option>
              <option value="import">Excel import</option>
            </Select>
          </Field>
          <Field label="Action contains" htmlFor="f-act">
            <Input id="f-act" value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }} placeholder="e.g. deactivated" />
          </Field>
          <Field label="Person" htmlFor="f-person">
            <Input id="f-person" value={person} onChange={(e) => { setPerson(e.target.value); setPage(0); }} />
          </Field>
          <Field label="From (IST)" htmlFor="f-from">
            <Input id="f-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
          </Field>
          <Field label="To (IST)" htmlFor="f-to">
            <Input id="f-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
          </Field>
        </div>
      </Card>
      <div className="mt-4">
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <Alert tone="error">{toAppError(q.error).message}</Alert>
        ) : !q.data?.rows.length ? (
          <EmptyState title="No matching activity" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th className={th} />
                  <th className={th}>When</th>
                  <th className={th}>Who</th>
                  <th className={th}>Action</th>
                  <th className={th}>Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {q.data.rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td className={td}>{open === r.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                      <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTimeIST(r.occurred_at, dateFormat)}</td>
                      <td className={td}>
                        {r.actor_name ?? <span className="text-slate-500">{r.source === "sql" ? "Database owner (SQL)" : r.source === "service" ? "Server process" : "System"}</span>}
                        {r.actor_role && <span className="ml-1 text-xs text-slate-400">({r.actor_role})</span>}
                      </td>
                      <td className={td}>
                        {label(r.action)} <Badge>{r.module}</Badge>
                      </td>
                      <td className={`${td} max-w-xs text-xs text-slate-600`}>{r.reason}</td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td />
                        <td colSpan={4} className="bg-slate-50 px-3 py-2">
                          <p className="mb-1 text-xs text-slate-500">
                            {r.entity_table && <>Record: {r.entity_table} {r.entity_id} · </>}Entry #{r.id}
                          </p>
                          <Diff row={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </Table>
            <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
              <span>
                {q.data.count} entries · page {page + 1} of {pages}
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <Button variant="secondary" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

interface AuthEvent {
  occurred_at: string;
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  ip_address: string | null;
  log_type: string | null;
}

function AuthEvents() {
  const dateFormat = useDateFormat();
  const q = useQuery({
    queryKey: ["auth-events"],
    queryFn: async () => unwrap(await supabase.rpc("admin_auth_events", { p_limit: 200 })) as AuthEvent[],
  });
  return (
    <>
      <Alert tone="info">
        Recorded by Supabase Auth (sign-in, sign-out, token and password events). Failed password attempts are rate-limited by Supabase but are not listed here.
      </Alert>
      <div className="mt-3">
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <Alert tone="error">{toAppError(q.error).message}</Alert>
        ) : !q.data?.length ? (
          <EmptyState title="No sign-in events recorded" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Event</th>
                <th className={th}>Account</th>
                <th className={th}>IP address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {q.data.map((e, i) => (
                <tr key={`${e.occurred_at}-${i}`}>
                  <td className={`${td} whitespace-nowrap text-xs`}>{formatDateTimeIST(e.occurred_at, dateFormat)}</td>
                  <td className={td}>{e.action}</td>
                  <td className={td}>{e.actor_email}</td>
                  <td className={`${td} text-xs`}>{e.ip_address || "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </>
  );
}
