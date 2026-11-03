import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Download, Plus, Search } from "lucide-react";
import { formatDate } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import type { JobRegisterRow } from "../../lib/types";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { useCategories, useVendors } from "../../hooks/master";
import { downloadWorkbook, type ExportSheet } from "../../lib/excel";
import { DateText, DueText, Money, StatusBadge, SourceBadge } from "../../components/jobs";
import { RevisionBadge, useRevisionLimit } from "../../components/commitments";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, cx, td, th } from "../../components/ui";

const PAGE_SIZE = 25;
const OPEN = ["Sent to Vendor", "In Progress", "Due Soon", "Due Today", "Overdue", "Commitment Date Missing"];

const TABS: Array<{ key: string; label: string; statuses?: string[]; archived?: boolean }> = [
  { key: "open", label: "Open", statuses: OPEN },
  { key: "overdue", label: "Overdue", statuses: ["Overdue"] },
  { key: "due", label: "Due today / soon", statuses: ["Due Today", "Due Soon"] },
  { key: "missing", label: "No commitment date", statuses: ["Commitment Date Missing"] },
  { key: "draft", label: "Drafts", statuses: ["Draft"] },
  { key: "completed", label: "Completed", statuses: ["Completed"] },
  { key: "cancelled", label: "Cancelled", statuses: ["Cancelled"] },
  { key: "all", label: "All" },
  { key: "archived", label: "Archived", archived: true },
];

const SORTS: Record<string, string> = {
  created: "created_at",
  job: "job_no",
  part: "part_label",
  vendor: "vendor_name",
  given: "date_given",
  commitment: "current_commitment_date",
  status: "status",
  amount: "amount",
};

type Filters = { tab: string; q: string; category: string; vendor: string; fy: string; from: string; to: string };

function clean(q: string): string {
  return q.replace(/[,()"*\\%]/g, " ").trim();
}

function buildQuery(f: Filters, select = "*", count = false) {
  let q = supabase.from("job_register").select(select, count ? { count: "exact" } : undefined);
  const tab = TABS.find((t) => t.key === f.tab) ?? TABS[0]!;
  q = tab.archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
  if (tab.statuses) q = q.in("status", tab.statuses);
  const term = clean(f.q);
  if (term) q = q.or(`job_no.ilike.*${term}*,part_label.ilike.*${term}*,vendor_name.ilike.*${term}*`);
  if (f.category) q = q.eq("category_id", f.category);
  if (f.vendor) q = q.eq("vendor_id", f.vendor);
  if (f.fy) q = q.eq("financial_year", f.fy);
  if (f.from) q = q.gte("date_given", f.from);
  if (f.to) q = q.lte("date_given", f.to);
  return q;
}

export function JobsRegisterPage() {
  const { can } = useAuth();
  const dateFormat = useDateFormat();
  const revisionLimit = useRevisionLimit();
  const categories = useCategories();
  const vendors = useVendors();
  const [params, setParams] = useSearchParams();
  const f: Filters = {
    tab: params.get("tab") ?? "open",
    q: params.get("q") ?? "",
    category: params.get("category") ?? "",
    vendor: params.get("vendor") ?? "",
    fy: params.get("fy") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
  };
  const page = Number(params.get("page") ?? "0");
  const sort = params.get("sort") ?? "created";
  const dir = params.get("dir") ?? "desc";
  const [search, setSearch] = useState(f.q);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!("page" in patch)) next.delete("page");
    setParams(next, { replace: true });
  };

  useRealtimeInvalidate(["jobs", "job_assignments"], ["jobs"]);
  useRealtimeInvalidate(["jobs", "job_assignments"], ["job-tab-counts"]);

  const list = useQuery({
    queryKey: ["jobs", f, page, sort, dir],
    queryFn: async () => {
      const res = await buildQuery(f, "*", true)
        .order(SORTS[sort] ?? "created_at", { ascending: dir === "asc", nullsFirst: false })
        .order("job_no", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      return { rows: unwrap(res) as unknown as JobRegisterRow[], count: res.count ?? 0 };
    },
  });

  // Tab counts (one light query of statuses)
  const counts = useQuery({
    queryKey: ["job-tab-counts"],
    queryFn: async () => {
      const rows = unwrap(await supabase.from("job_register").select("status,archived_at").limit(20000)) as Array<{ status: string; archived_at: string | null }>;
      const out: Record<string, number> = {};
      for (const t of TABS) {
        out[t.key] = rows.filter((r) => (t.archived ? r.archived_at !== null : r.archived_at === null) && (!t.statuses || t.statuses.includes(r.status))).length;
      }
      return out;
    },
  });

  const fyOptions = useMemo(() => {
    const now = new Date();
    const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    return Array.from({ length: 6 }, (_, i) => `${y - i}-${String((y - i + 1) % 100).padStart(2, "0")}`);
  }, []);

  async function exportExcel() {
    setExporting(true);
    setExportError(null);
    try {
      const rows = unwrap(await buildQuery(f).order("created_at", { ascending: false }).limit(5000)) as unknown as JobRegisterRow[];
      const sheet: ExportSheet<JobRegisterRow> = {
        name: "Jobs Register",
        title: `CESS Machining Jobs Register - exported ${formatDate(new Date().toISOString().slice(0, 10), dateFormat)}`,
        rows,
        columns: [
          { header: "Job ID", value: (r) => r.job_no, width: 16 },
          { header: "Part No / Part Name", value: (r) => r.part_label, width: 32 },
          { header: "Description", value: (r) => r.description, width: 24 },
          { header: "Vendor", value: (r) => r.vendor_name, width: 24 },
          { header: "Vendor changes", value: (r) => Math.max(0, r.assignment_count - 1), format: "int" },
          { header: "Category", value: (r) => r.category_name, width: 20 },
          { header: "Given By", value: (r) => r.given_by_name },
          { header: "Assigned Staff User", value: (r) => r.assigned_staff_name, width: 20 },
          { header: "Created By", value: (r) => r.created_by_name, width: 18 },
          { header: "Date Given", value: (r) => r.date_given, format: "date" },
          { header: "Original Commitment Date", value: (r) => r.original_commitment_date, format: "date" },
          { header: "Current Commitment Date", value: (r) => r.current_commitment_date, format: "date" },
          { header: "Commitment Revisions", value: (r) => r.revision_count, format: "int" },
          { header: "Actual Return Date", value: (r) => r.return_date, format: "date" },
          { header: "Quantity Sent", value: (r) => r.qty_sent, format: "int" },
          { header: "Job Amount (₹)", value: (r) => r.amount, format: "inr" },
          { header: "Days Since Given", value: (r) => r.days_since_given, format: "int" },
          { header: "Delay Days (vs original)", value: (r) => r.delay_days, format: "int" },
          { header: "Status", value: (r) => r.status, width: 22 },
          { header: "Financial Year", value: (r) => r.financial_year },
          { header: "Remarks", value: (r) => r.remarks, width: 30 },
        ],
      };
      await downloadWorkbook(`CESS-Jobs-Register-${new Date().toISOString().slice(0, 10)}.xlsx`, [sheet]);
      await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "jobs", p_details: { what: "jobs register", rows: rows.length, filters: f } });
    } catch (e) {
      setExportError(toAppError(e).message);
    } finally {
      setExporting(false);
    }
  }

  const sortHeader = (key: string, label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 uppercase"
      onClick={() => update({ sort: key, dir: sort === key && dir === "asc" ? "desc" : "asc" })}
    >
      {label}
      {sort === key && (dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
    </button>
  );
  const pages = Math.max(1, Math.ceil((list.data?.count ?? 0) / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Jobs Register"
        description="Every outsourced job with its current vendor. Status and day counts are calculated live (Indian time)."
        actions={
          <>
            {can("reports.export") && (
              <Button variant="secondary" onClick={() => void exportExcel()} loading={exporting}>
                <Download className="h-4 w-4" /> Export to Excel
              </Button>
            )}
            {can("jobs.create") && (
              <Link to="/jobs/new">
                <Button>
                  <Plus className="h-4 w-4" /> New job
                </Button>
              </Link>
            )}
          </>
        }
      />
      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={f.tab === t.key}
            onClick={() => update({ tab: t.key })}
            className={cx(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
              f.tab === t.key ? "border-brand-700 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {t.label}
            {counts.data && <span className={cx("ml-1.5 rounded-full px-1.5 text-xs", t.key === "overdue" && (counts.data[t.key] ?? 0) > 0 ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600")}>{counts.data[t.key]}</span>}
          </button>
        ))}
      </div>
      <Card>
        <form
          className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() });
          }}
        >
          <div className="col-span-2">
            <Field label="Search job ID, part or vendor" htmlFor="jr-q">
              <div className="flex gap-2">
                <Input id="jr-q" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. 4711 or Shree" />
                <Button type="submit" variant="secondary" aria-label="Search">
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </Field>
          </div>
          <Field label="Category" htmlFor="jr-cat">
            <Select id="jr-cat" value={f.category} onChange={(e) => update({ category: e.target.value })}>
              <option value="">All</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor" htmlFor="jr-vendor">
            <Select id="jr-vendor" value={f.vendor} onChange={(e) => update({ vendor: e.target.value })}>
              <option value="">All</option>
              {vendors.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Financial year" htmlFor="jr-fy">
            <Select id="jr-fy" value={f.fy} onChange={(e) => update({ fy: e.target.value })}>
              <option value="">All</option>
              {fyOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Given from" htmlFor="jr-from">
            <Input id="jr-from" type="date" value={f.from} onChange={(e) => update({ from: e.target.value })} />
          </Field>
          <Field label="Given to" htmlFor="jr-to">
            <Input id="jr-to" type="date" value={f.to} onChange={(e) => update({ to: e.target.value })} />
          </Field>
        </form>
      </Card>
      {exportError && (
        <div className="mt-3">
          <Alert tone="error">{exportError}</Alert>
        </div>
      )}
      <div className="mt-4">
        {list.isLoading ? (
          <Spinner />
        ) : list.error ? (
          <Alert tone="error">{toAppError(list.error).message}</Alert>
        ) : !list.data?.rows.length ? (
          <EmptyState title="No jobs match">
            {f.q || f.category || f.vendor || f.fy || f.from || f.to ? "Try clearing the search or filters." : can("jobs.create") ? "Create the first job with New job." : null}
          </EmptyState>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <th className={th}>{sortHeader("job", "Job ID")}</th>
                  <th className={th}>{sortHeader("status", "Status")}</th>
                  <th className={th}>{sortHeader("part", "Part No / Name")}</th>
                  <th className={th}>{sortHeader("vendor", "Vendor")}</th>
                  <th className={th}>{sortHeader("given", "Given")}</th>
                  <th className={th}>{sortHeader("commitment", "Commitment")}</th>
                  <th className={th}>Returned</th>
                  <th className={th}>Qty</th>
                  <th className={th}>{sortHeader("amount", "Amount")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {list.data.rows.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className={td}>
                      <Link to={`/jobs/${r.id}`} className="whitespace-nowrap font-medium text-brand-700 hover:underline">
                        {r.job_no}
                      </Link>
                      <div>
                        <SourceBadge source={r.source} />
                      </div>
                    </td>
                    <td className={`${td} min-w-28`}>
                      <StatusBadge status={r.status} />
                      <div>
                        <DueText remaining={r.remaining_days} delay={r.status === "Overdue" ? r.delay_days_current : null} />
                      </div>
                    </td>
                    <td className={`${td} min-w-44 max-w-xs`}>
                      <p className="font-medium">{r.part_label}</p>
                      <p className="text-xs text-slate-500">
                        {r.category_name}
                        {r.given_by_name ? ` · given by ${r.given_by_name}` : ""}
                      </p>
                    </td>
                    <td className={`${td} min-w-32`}>
                      {r.vendor_name ?? <span className="text-slate-400">—</span>}
                      {r.assignment_count > 1 && <p className="text-xs text-amber-700">{r.assignment_count} vendors (forwarded)</p>}
                    </td>
                    <td className={td}>
                      <DateText value={r.date_given} format={dateFormat} />
                    </td>
                    <td className={td}>
                      <DateText value={r.current_commitment_date} format={dateFormat} />
                      {r.original_commitment_date && r.original_commitment_date !== r.current_commitment_date && (
                        <p className="text-xs text-slate-400 line-through">{formatDate(r.original_commitment_date, dateFormat)}</p>
                      )}
                      {r.revision_count > 0 && <div className="mt-0.5"><RevisionBadge count={r.revision_count} limit={revisionLimit} /></div>}
                    </td>
                    <td className={td}>
                      <DateText value={r.return_date} format={dateFormat} />
                    </td>
                    <td className={`${td} tabular-nums`}>{r.qty_sent ?? <span className="text-slate-400">—</span>}</td>
                    <td className={td}>
                      <Money value={r.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
              <span>
                {list.data.count} job{list.data.count === 1 ? "" : "s"} · page {page + 1} of {pages}
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={page === 0} onClick={() => update({ page: String(page - 1) })}>
                  Previous
                </Button>
                <Button variant="secondary" disabled={page + 1 >= pages} onClick={() => update({ page: String(page + 1) })}>
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
