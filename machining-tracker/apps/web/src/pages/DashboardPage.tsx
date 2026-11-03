import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDate, formatINR, recentFinancialYears, todayIST, type DateFormat } from "@cess/shared";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import { useDateFormat, useRealtimeInvalidate } from "../hooks/data";
import { JobTrendChart, RankedBars, RejectionTrendChart, SERIES_1, SERIES_2, STATUS, SegmentedBar, SpendingChart } from "../components/dashboardCharts";
import { StatusBadge } from "../components/jobs";
import { Alert, Badge, Card, Select, Spinner, cx } from "../components/ui";

interface Dash {
  fy: string;
  from: string;
  to: string;
  today: string;
  month_start: string;
  can_payments: boolean;
  can_reliability: boolean;
  kpis: Record<"active" | "pending" | "drafts" | "overdue" | "due_today" | "inspection_pending" | "partially_returned" | "new_this_month" | "new_fy" | "completed_this_month" | "completed_fy", number>;
  money: { spending_fy: number; spending_month: number; outstanding: number; outstanding_accounts: number } | null;
  reliability: { average: number | null; scored_vendors: number; vendors: number; ranking: Array<{ vendor_id: string; vendor_name: string; score: number; label: string; eligible_jobs: number }> } | null;
  quality: { inspected: number; accepted: number; rejected: number; rework: number; acceptance_pct: number | null };
  monthly: Array<{ month: string; started: number; completed: number; spending: number | null; inspected: number; rejected_or_rework: number; future: boolean }>;
  vendors: Array<{ vendor_id: string; vendor_name: string; jobs: number }>;
  categories: Array<{ category_id: string; category_name: string; jobs: number }>;
  completion_split: { completed: number; pending: number; cancelled: number };
  on_time: { on_time: number; late: number; no_commitment: number };
  tables: {
    overdue: Array<{ id: string; job_no: string; part_label: string; vendor_id: string; vendor_name: string; current_commitment_date: string; delay_days_current: number; qty_with_vendor: number | null }>;
    upcoming: Array<{ id: string; job_no: string; part_label: string; vendor_name: string; current_commitment_date: string; remaining_days: number; status: string; qty_with_vendor: number | null }>;
    recent_added: Array<{ id: string; job_no: string; part_label: string; vendor_name: string | null; status: string; created_at: string; created_by_name: string | null }>;
    recent_completed: Array<{ id: string; job_no: string; part_label: string; vendor_name: string | null; closed_on: string; qty_accepted: number; qty_rejected: number }>;
    pending_inspections: Array<{ job_id: string; job_no: string; part_label: string; vendor_name: string; return_no: number; returned_on: string; qty_uninspected: number }>;
    pending_payments: Array<{ job_id: string; job_no: string; part_label: string; vendor_name: string; total_payable: number; amount_paid: number; balance: number; payment_status: string }> | null;
    vendor_followups: Array<{ vendor_id: string; vendor_name: string; overdue_jobs: number; max_delay_days: number | null; reliability_label: string | null }>;
  };
}

const OPEN_STATUSES = ["Sent to Vendor", "In Progress", "Due Soon", "Due Today", "Overdue", "Commitment Date Missing", "Partially Returned", "Quality Inspection Pending"];
const qs = (o: Record<string, string>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v)).toString();
const monthEnd = (m: string) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

function Kpi({ label, value, hint, to, tone }: { label: string; value: ReactNode; hint?: ReactNode; to: string; tone?: string }) {
  return (
    <Link to={to} className="group rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-brand-600">
      <p className="text-xs font-medium text-slate-500 group-hover:text-brand-700">{label}</p>
      <p className={cx("mt-1 text-2xl font-semibold tabular-nums", tone ?? "text-slate-900")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </Link>
  );
}

function MiniTable({ title, to, empty, children }: { title: string; to?: string; empty: boolean; children: ReactNode }) {
  return (
    <Card title={title} actions={to ? <Link to={to} className="text-xs font-medium text-brand-700 hover:underline">View all</Link> : undefined}>
      {empty ? <p className="text-sm text-slate-500">Nothing here.</p> : <ul className="divide-y divide-slate-100">{children}</ul>}
    </Card>
  );
}

function Row({ to, title, sub, right }: { to: string; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2 text-sm">
      <span className="min-w-0">
        <Link to={to} className="font-medium text-brand-700 hover:underline">
          {title}
        </Link>
        {sub && <span className="block truncate text-xs text-slate-500">{sub}</span>}
      </span>
      {right && <span className="shrink-0 text-right text-xs">{right}</span>}
    </li>
  );
}

export function Dashboard() {
  const dateFormat = useDateFormat();
  const navigate = useNavigate();
  const years = useMemo(() => recentFinancialYears(todayIST(), 8), []);
  const [fy, setFy] = useState(years[0]!);
  useRealtimeInvalidate(["jobs", "job_assignments", "material_returns", "quality_inspections", "vendor_payments"], ["dashboard"]);
  const q = useQuery({
    queryKey: ["dashboard", fy],
    queryFn: async () => unwrap(await supabase.rpc("dashboard_data", { p_fy: fy })) as Dash,
  });
  if (q.isLoading) return <Spinner label="Loading dashboard..." />;
  if (q.error) return <Alert tone="error">{toAppError(q.error).message}</Alert>;
  const d = q.data!;
  const k = d.kpis;
  const fyRange = { sfrom: d.from, sto: d.to };
  const vendorsTop = d.vendors.slice(0, 8);
  const otherJobs = d.vendors.slice(8).reduce((a, v) => a + v.jobs, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          Live figures from the database. Period figures use financial year {d.fy}; "now" figures are as of today. Click any number or chart to open the records.
        </p>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-slate-700">
          Financial year
          <Select value={fy} onChange={(e) => setFy(e.target.value)} className="w-28" aria-label="Financial year">
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </Select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Active jobs (with vendors)" value={k.active} hint={`${k.partially_returned} partly back · ${k.inspection_pending} to inspect`} to={`/jobs?${qs({ tab: "open" })}`} />
        <Kpi label="New jobs this month" value={k.new_this_month} hint={`${k.new_fy} in FY ${d.fy}`} to={`/jobs?${qs({ tab: "all", sfrom: d.month_start, sto: d.today })}`} />
        <Kpi label="Pending jobs" value={k.pending} hint={`incl. ${k.drafts} draft${k.drafts === 1 ? "" : "s"}`} to={`/jobs?${qs({ tab: "all", status: [...OPEN_STATUSES, "Draft"].join(",") })}`} />
        <Kpi label="Overdue" value={k.overdue} tone={k.overdue ? "text-red-700" : undefined} to="/jobs?tab=overdue" />
        <Kpi label="Due today" value={k.due_today} tone={k.due_today ? "text-amber-700" : undefined} to={`/jobs?${qs({ tab: "all", status: "Due Today" })}`} />
        <Kpi label={`Completed (FY ${d.fy})`} value={k.completed_fy} hint={`${k.completed_this_month} this month`} to={`/jobs?${qs({ tab: "completed", cfrom: d.from, cto: d.to })}`} />
        {d.money && <Kpi label={`Vendor spending (FY ${d.fy})`} value={formatINR(d.money.spending_fy, true)} hint={`${formatINR(d.money.spending_month, true)} this month`} to="/payments?tab=periods" />}
        {d.money && <Kpi label="Outstanding payments" value={formatINR(d.money.outstanding, true)} tone={d.money.outstanding ? "text-red-700" : undefined} hint={`${d.money.outstanding_accounts} job account${d.money.outstanding_accounts === 1 ? "" : "s"}`} to="/payments?tab=pending" />}
        {d.reliability && (
          <Kpi
            label="Average vendor reliability"
            value={d.reliability.average === null ? "—" : d.reliability.average.toFixed(1)}
            hint={d.reliability.average === null ? `no vendor has enough jobs yet (${d.reliability.vendors} vendors)` : `${d.reliability.scored_vendors} of ${d.reliability.vendors} vendors scored`}
            to={`/vendors/reliability?fy=${d.fy}`}
          />
        )}
        <Kpi
          label="Quality acceptance"
          value={d.quality.acceptance_pct === null ? "—" : `${d.quality.acceptance_pct.toFixed(1)}%`}
          hint={d.quality.inspected ? `${d.quality.accepted} of ${d.quality.inspected} pieces` : "no inspections this FY"}
          to={`/quality?fy=${d.fy}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <JobTrendChart months={d.monthly} onMonth={(m) => navigate(`/jobs?${qs({ tab: "all", sfrom: `${m}-01`, sto: monthEnd(m) })}`)} />
        </Card>
        {d.money ? (
          <Card>
            <SpendingChart months={d.monthly} onMonth={() => navigate("/payments?tab=periods")} />
          </Card>
        ) : (
          <Card>
            <RejectionTrendChart months={d.monthly} />
          </Card>
        )}
        <Card>
          <RankedBars
            title="Vendor-wise job distribution"
            valueLabel="jobs"
            rows={[...vendorsTop.map((v) => ({ key: v.vendor_id, label: v.vendor_name, value: v.jobs })), ...(otherJobs ? [{ key: "", label: `${d.vendors.length - 8} other vendors`, value: otherJobs }] : [])]}
            onClick={(id) => id && navigate(`/jobs?${qs({ tab: "all", vendor: id, fy: d.fy })}`)}
            note="Jobs given to each vendor in the financial year (a forwarded job counts for each vendor)."
          />
        </Card>
        <Card>
          <RankedBars
            title="Category-wise machining work"
            valueLabel="jobs"
            rows={d.categories.map((c) => ({ key: c.category_id, label: c.category_name, value: c.jobs }))}
            onClick={(id) => navigate(`/jobs?${qs({ tab: "all", category: id, ...fyRange })}`)}
            note="Jobs started in the financial year."
          />
        </Card>
        <Card>
          <div className="space-y-6">
            <SegmentedBar
              title="Completed vs pending jobs"
              note="Jobs started in the financial year."
              parts={[
                { key: "c", label: "Completed", value: d.completion_split.completed, color: SERIES_1, onClick: () => navigate(`/jobs?${qs({ tab: "completed", ...fyRange })}`) },
                { key: "p", label: "Pending", value: d.completion_split.pending, color: SERIES_2, textColor: "#0b0b0b", onClick: () => navigate(`/jobs?${qs({ tab: "all", status: [...OPEN_STATUSES, "Draft"].join(","), ...fyRange })}`) },
                { key: "x", label: "Cancelled", value: d.completion_split.cancelled, color: "#94a3b8", textColor: "#0b0b0b", onClick: () => navigate(`/jobs?${qs({ tab: "cancelled", ...fyRange })}`) },
              ]}
            />
            <SegmentedBar
              title="On-time vs delayed (against the original committed date)"
              note={`Vendor assignments completed in the financial year.${d.on_time.no_commitment ? ` ${d.on_time.no_commitment} without a committed date are not counted.` : ""}`}
              parts={[
                { key: "ok", label: "✓ On time", value: d.on_time.on_time, color: STATUS.good, onClick: () => navigate(`/vendors/reliability?fy=${d.fy}`) },
                { key: "late", label: "! Late", value: d.on_time.late, color: STATUS.critical, onClick: () => navigate(`/vendors/reliability?fy=${d.fy}`) },
              ]}
            />
          </div>
        </Card>
        {d.reliability && (
          <Card>
            <RankedBars
              title="Vendor reliability ranking"
              valueLabel="score"
              max={100}
              format={(v) => v.toFixed(1)}
              rows={d.reliability.ranking.slice(0, 10).map((r) => ({ key: r.vendor_id, label: r.vendor_name, value: r.score, tag: r.label }))}
              onClick={(id) => navigate(`/vendors/${id}`)}
              note={
                d.reliability.vendors > d.reliability.scored_vendors
                  ? `${d.reliability.vendors - d.reliability.scored_vendors} vendor${d.reliability.vendors - d.reliability.scored_vendors === 1 ? " has" : "s have"} too few jobs for a score.`
                  : undefined
              }
            />
          </Card>
        )}
        {d.money && (
          <Card>
            <RejectionTrendChart months={d.monthly} />
          </Card>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <MiniTable title={`Overdue jobs (${k.overdue})`} to="/jobs?tab=overdue" empty={!d.tables.overdue.length}>
          {d.tables.overdue.map((r) => (
            <Row key={r.id} to={`/jobs/${r.id}`} title={r.job_no} sub={`${r.part_label} · ${r.vendor_name}`} right={<span className="font-medium text-red-700">{r.delay_days_current} days late</span>} />
          ))}
        </MiniTable>
        <MiniTable title="Upcoming deliveries (next 7 days)" to="/jobs?tab=due" empty={!d.tables.upcoming.length}>
          {d.tables.upcoming.map((r) => (
            <Row key={r.id} to={`/jobs/${r.id}`} title={r.job_no} sub={`${r.part_label} · ${r.vendor_name}`} right={<>{formatDate(r.current_commitment_date, dateFormat)}<br /><StatusBadge status={r.status} /></>} />
          ))}
        </MiniTable>
        <MiniTable title="Recently added jobs" to="/jobs?tab=all" empty={!d.tables.recent_added.length}>
          {d.tables.recent_added.map((r) => (
            <Row key={r.id} to={`/jobs/${r.id}`} title={r.job_no} sub={`${r.part_label}${r.vendor_name ? ` · ${r.vendor_name}` : ""}`} right={<StatusBadge status={r.status} />} />
          ))}
        </MiniTable>
        <MiniTable title="Recently completed jobs" to="/jobs?tab=completed" empty={!d.tables.recent_completed.length}>
          {d.tables.recent_completed.map((r) => (
            <Row key={r.id} to={`/jobs/${r.id}`} title={r.job_no} sub={`${r.part_label}${r.vendor_name ? ` · ${r.vendor_name}` : ""}`} right={<>{formatDate(r.closed_on, dateFormat)}{r.qty_rejected ? <span className="block text-red-700">{r.qty_rejected} rejected</span> : null}</>} />
          ))}
        </MiniTable>
        <MiniTable title="Pending quality inspections" to="/quality?tab=pending" empty={!d.tables.pending_inspections.length}>
          {d.tables.pending_inspections.map((r) => (
            <Row key={`${r.job_id}-${r.return_no}`} to={`/jobs/${r.job_id}`} title={r.job_no} sub={`${r.part_label} · ${r.vendor_name}`} right={<><strong>{r.qty_uninspected} pcs</strong><br />back {formatDate(r.returned_on, dateFormat)}</>} />
          ))}
        </MiniTable>
        {d.tables.pending_payments && (
          <MiniTable title="Pending payments" to="/payments?tab=pending" empty={!d.tables.pending_payments.length}>
            {d.tables.pending_payments.map((r) => (
              <Row key={`${r.job_id}-${r.vendor_name}`} to={`/jobs/${r.job_id}`} title={r.job_no} sub={`${r.part_label} · ${r.vendor_name}`} right={<><strong className="text-red-700">{formatINR(r.balance)}</strong><br />{r.payment_status}</>} />
            ))}
          </MiniTable>
        )}
        <MiniTable title="Vendors requiring follow-up" to="/whatsapp" empty={!d.tables.vendor_followups.length}>
          {d.tables.vendor_followups.map((r) => (
            <Row
              key={r.vendor_id}
              to={`/vendors/${r.vendor_id}`}
              title={r.vendor_name}
              sub={r.overdue_jobs ? `${r.overdue_jobs} overdue job${r.overdue_jobs === 1 ? "" : "s"}${r.max_delay_days ? `, up to ${r.max_delay_days} days late` : ""}` : "Low reliability score"}
              right={r.reliability_label ? <Badge tone={r.reliability_label === "Needs Improvement" ? "red" : "slate"}>{r.reliability_label}</Badge> : undefined}
            />
          ))}
        </MiniTable>
      </div>
    </div>
  );
}

/** Home for users without reports: their own jobs only (the database decides which jobs they can see). */
export function MyJobsSummary({ dateFormat }: { dateFormat: DateFormat }) {
  useRealtimeInvalidate(["jobs", "job_assignments", "material_returns"], ["my-jobs"]);
  const q = useQuery({
    queryKey: ["my-jobs"],
    queryFn: async () => unwrap(await supabase.from("job_register").select("id,job_no,part_label,vendor_name,status,current_commitment_date").is("archived_at", null).limit(2000)) as Array<{ id: string; job_no: string; part_label: string; vendor_name: string | null; status: string; current_commitment_date: string | null }>,
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert tone="error">{toAppError(q.error).message}</Alert>;
  const rows = q.data ?? [];
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const attention = rows.filter((r) => ["Overdue", "Due Today", "Due Soon", "Commitment Date Missing"].includes(r.status)).sort((a, b) => (a.current_commitment_date ?? "").localeCompare(b.current_commitment_date ?? ""));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label="My open jobs" value={rows.filter((r) => !["Draft", "Completed", "Cancelled"].includes(r.status)).length} to="/jobs?tab=open" />
        <Kpi label="Overdue" value={count("Overdue")} tone={count("Overdue") ? "text-red-700" : undefined} to="/jobs?tab=overdue" />
        <Kpi label="Due today" value={count("Due Today")} to={`/jobs?${qs({ tab: "all", status: "Due Today" })}`} />
        <Kpi label="Drafts" value={count("Draft")} to="/jobs?tab=draft" />
      </div>
      <MiniTable title="Needs attention" to="/jobs?tab=open" empty={!attention.length}>
        {attention.slice(0, 15).map((r) => (
          <Row key={r.id} to={`/jobs/${r.id}`} title={r.job_no} sub={`${r.part_label}${r.vendor_name ? ` · ${r.vendor_name}` : ""}`} right={<>{r.current_commitment_date ? formatDate(r.current_commitment_date, dateFormat) : ""}<br /><StatusBadge status={r.status} /></>} />
        ))}
      </MiniTable>
    </div>
  );
}
