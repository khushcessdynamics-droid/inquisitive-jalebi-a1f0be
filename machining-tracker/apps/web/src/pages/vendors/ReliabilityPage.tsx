import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, Info } from "lucide-react";
import { RELIABILITY_FACTOR_LABELS, RELIABILITY_FACTORS, recentFinancialYears, todayIST } from "@cess/shared";
import { supabase } from "../../lib/supabase";
import { toAppError } from "../../lib/errors";
import { downloadWorkbook, type ExportSheet } from "../../lib/excel";
import type { ReliabilityRow } from "../../lib/phase5Types";
import { useDateFormat } from "../../hooks/data";
import { useCategories } from "../../hooks/master";
import { ReliabilityDetail, ScoreCell, useReliability } from "../../components/reliability";
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, Select, Spinner, Table, td, th } from "../../components/ui";

export function ReliabilityPage() {
  const [params, setParams] = useSearchParams();
  const fy = params.get("fy") ?? recentFinancialYears(todayIST(), 1)[0]!;
  const category = params.get("category") ?? "";
  const view = params.get("view") === "category" ? "category" : "overall";
  const filters = { fy: fy === "all" ? undefined : fy, category_id: category || undefined, by_category: view === "category" };
  const result = useReliability(filters);
  const categories = useCategories();
  const dateFormat = useDateFormat();
  const [detail, setDetail] = useState<ReliabilityRow | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const years = useMemo(() => recentFinancialYears(todayIST(), 12), []);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const s = result.data?.settings;
  const rows = result.data?.rows ?? [];

  async function exportExcel() {
    setExportError(null);
    try {
      const ranking: ExportSheet<ReliabilityRow> = {
        name: "Vendor Reliability",
        title: `CESS vendor reliability - ${filters.fy ? `FY ${filters.fy}` : "all years"}${category ? ` - ${categories.data?.find((c) => c.id === category)?.name}` : ""}`,
        columns: [
          { header: "Rank", value: (r) => r.rank, format: "int" },
          { header: "Vendor", value: (r) => r.vendor_name, width: 28 },
          ...(view === "category" ? [{ header: "Category", value: (r: ReliabilityRow) => r.category_name, width: 22 }] : []),
          { header: "Score", value: (r) => r.score },
          { header: "Label", value: (r) => r.label ?? (r.status === "insufficient_jobs" ? `Insufficient data (${r.eligible_jobs} of ${r.min_eligible_jobs} jobs)` : "Not enough factors") , width: 26 },
          { header: "Eligible jobs", value: (r) => r.eligible_jobs, format: "int" },
          { header: "Returned", value: (r) => r.counts.completed, format: "int" },
          { header: "Vendor-caused cancellations", value: (r) => r.counts.vendor_cancelled, format: "int" },
          { header: "Other cancellations (excluded)", value: (r) => r.counts.other_cancelled + r.counts.unclassified_cancelled, format: "int" },
          { header: "Open now", value: (r) => r.counts.open, format: "int" },
          { header: "Overdue now", value: (r) => r.counts.overdue_now, format: "int" },
          { header: "On-time %", value: (r) => r.measures.on_time_pct },
          { header: "Avg delay when late (days)", value: (r) => r.measures.avg_delay_when_late },
          { header: "Total delay days", value: (r) => r.measures.total_delay_days, format: "int" },
          { header: "Revisions (all)", value: (r) => r.measures.revisions, format: "int" },
          { header: "Revisions by vendor", value: (r) => r.measures.revisions_vendor, format: "int" },
          { header: "Frequently revises", value: (r) => (r.measures.frequent_reviser ? "Yes" : "") },
          ...RELIABILITY_FACTORS.map((k) => ({ header: `${RELIABILITY_FACTOR_LABELS[k]} score`, value: (r: ReliabilityRow) => r.factors.find((x) => x.key === k)?.score ?? null })),
        ],
        rows,
      };
      const formula: ExportSheet<{ item: string; value: string }> = {
        name: "Formula",
        title: "How the reliability score is calculated",
        columns: [
          { header: "Item", value: (r) => r.item, width: 34 },
          { header: "Value", value: (r) => r.value, width: 90 },
        ],
        rows: [
          ...RELIABILITY_FACTORS.map((k) => ({ item: `${RELIABILITY_FACTOR_LABELS[k]} weight`, value: `${s?.weights[k]}%` })),
          { item: "Minimum eligible jobs", value: String(s?.min_eligible_jobs) },
          { item: "Minimum factors with data", value: String(s?.min_factors) },
          { item: "Delay cap (days)", value: String(s?.delay_cap_days) },
          { item: "Revisions per job limit", value: String(s?.stability_revisions_cap) },
          { item: "Rule", value: "On-time and delay are measured against the ORIGINAL committed date. Only vendor-caused cancellations count, once, in the cancellation factor. Non-vendor cancellations, open jobs and jobs without data are excluded. Missing factors are left out and the other weights scaled up to 100%." },
        ],
      };
      await downloadWorkbook(`CESS-Vendor-Reliability-${filters.fy ?? "all-years"}-${new Date().toISOString().slice(0, 10)}.xlsx`, [ranking, formula]);
      await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "vendors", p_details: { what: "vendor reliability", rows: rows.length, filters } });
    } catch (e) {
      setExportError(toAppError(e).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Vendor Reliability"
        description="Calculated from recorded jobs every time you open this page. Only eligible jobs are used; the number of jobs is shown with every score."
        actions={
          <Button variant="secondary" onClick={exportExcel} disabled={!rows.length}>
            <Download className="h-4 w-4" /> Export to Excel
          </Button>
        }
      />
      <Card>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Financial year" htmlFor="rel-fy">
            <Select id="rel-fy" value={fy} onChange={(e) => set("fy", e.target.value)}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
              <option value="all">All years</option>
            </Select>
          </Field>
          <Field label="Machining category" htmlFor="rel-cat">
            <Select id="rel-cat" value={category} onChange={(e) => set("category", e.target.value)}>
              <option value="">All categories</option>
              {(categories.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show" htmlFor="rel-view">
            <Select id="rel-view" value={view} onChange={(e) => set("view", e.target.value === "category" ? "category" : "")}>
              <option value="overall">One score per vendor</option>
              <option value="category">Score per vendor and category</option>
            </Select>
          </Field>
        </div>
      </Card>

      {s && (
        <details className="mt-4 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <summary className="flex cursor-pointer items-center gap-2 font-semibold text-slate-800">
            <Info className="h-4 w-4" /> How the score works
          </summary>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <ul className="space-y-1">
              {RELIABILITY_FACTORS.map((k) => (
                <li key={k} className="flex justify-between gap-4 border-b border-slate-100 pb-1">
                  <span>{RELIABILITY_FACTOR_LABELS[k]}</span>
                  <span className="tabular-nums font-medium">{s.weights[k]}%</span>
                </li>
              ))}
            </ul>
            <ul className="list-disc space-y-1 pl-5 text-slate-700">
              <li>On-time and delay are measured against the <strong>original</strong> committed date. Jobs without a committed date are left out of them.</li>
              <li>Delay = 100 × (1 − average days late ÷ {s.delay_cap_days}), only over late jobs. Stability = 100 × (1 − vendor-requested revisions per job ÷ {s.stability_revisions_cap}).</li>
              <li>Completion time compares the vendor with the usual (median) days for the same category, across all vendors.</li>
              <li>Only <strong>vendor-caused</strong> cancellations count, once, in the cancellation factor. Other cancellations and open jobs are excluded.</li>
              <li>
                No score below {s.min_eligible_jobs} eligible jobs or with fewer than {s.min_factors} factors. Factors without data are left out and the other weights scaled up to 100%. Quality
                comes from inspections (Phase 6).
              </li>
              <li>
                Labels: {s.labels.excellent}+ Excellent · {s.labels.good}+ Good · {s.labels.average}+ Average · below {s.labels.average} Needs Improvement. Weights are changed in Settings.
              </li>
            </ul>
          </div>
        </details>
      )}

      <div className="mt-4">
        {exportError && <Alert tone="error">{exportError}</Alert>}
        {result.isLoading ? (
          <Spinner />
        ) : result.error ? (
          <Alert tone="error">{toAppError(result.error).message}</Alert>
        ) : !rows.length ? (
          <EmptyState title="No vendor jobs in this period">Choose another financial year or category.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={`${th} w-12`}>Rank</th>
                <th className={th}>Vendor</th>
                <th className={th}>Score</th>
                <th className={`${th} text-right`}>Jobs used</th>
                <th className={`${th} text-right`}>On-time</th>
                <th className={`${th} text-right`}>Avg delay when late</th>
                <th className={th}>Revisions</th>
                <th className={th}>Cancellations</th>
                <th className={`${th} text-right`}>Overdue now</th>
                <th className={th}>
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={`${r.vendor_id}:${r.category_id ?? ""}`}>
                  <td className={`${td} tabular-nums text-slate-500`}>{r.rank ?? "—"}</td>
                  <td className={td}>
                    <Link to={`/vendors/${r.vendor_id}`} className="font-medium text-brand-700 hover:underline">
                      {r.vendor_name}
                    </Link>
                    {r.category_name && <p className="text-xs text-slate-500">{r.category_name}</p>}
                  </td>
                  <td className={td}>
                    <ScoreCell row={r} />
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {r.eligible_jobs}
                    <span className="block text-xs text-slate-500">of {r.counts.total} given</span>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {r.measures.on_time_pct === null ? "—" : `${r.measures.on_time_pct.toFixed(1)}%`}
                    <span className="block text-xs text-slate-500">
                      {r.counts.on_time} of {r.counts.committed_completed}
                    </span>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{r.measures.avg_delay_when_late === null ? "—" : `${r.measures.avg_delay_when_late.toFixed(1)} d`}</td>
                  <td className={td}>
                    <span className="tabular-nums">{r.measures.revisions}</span>
                    <span className="text-xs text-slate-500"> ({r.measures.revisions_vendor} by vendor)</span>
                    {r.measures.frequent_reviser && (
                      <span className="block">
                        <Badge tone="amber">Frequently revises</Badge>
                      </span>
                    )}
                  </td>
                  <td className={`${td} text-xs`}>
                    <span className={r.counts.vendor_cancelled ? "font-medium text-red-700" : ""}>{r.counts.vendor_cancelled} vendor-caused</span>
                    <span className="block text-slate-500">{r.counts.other_cancelled + r.counts.unclassified_cancelled} other (excluded)</span>
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{r.counts.overdue_now}</td>
                  <td className={td}>
                    <Button variant="ghost" className="whitespace-nowrap" onClick={() => setDetail(r)}>
                      How calculated
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
      {detail && (
        <ReliabilityDetail
          vendorId={detail.vendor_id}
          vendorName={detail.vendor_name + (detail.category_name ? ` · ${detail.category_name}` : "")}
          filters={{ fy: filters.fy, category_id: detail.category_id ?? filters.category_id }}
          dateFormat={dateFormat}
          open
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}
