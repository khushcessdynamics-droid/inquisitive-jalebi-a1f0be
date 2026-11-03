import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { RELIABILITY_FACTOR_LABELS, formatDate, type DateFormat, type ReliabilityFactor } from "@cess/shared";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import { downloadWorkbook, type ExportSheet } from "../lib/excel";
import type { ReliabilityBucket, ReliabilityJob, ReliabilityResult, ReliabilityRow } from "../lib/phase5Types";
import { useRealtimeInvalidate } from "../hooks/data";
import { Alert, Badge, Button, Modal, Spinner, Table, cx, td, th } from "./ui";

export interface ReliabilityFilters {
  fy?: string;
  category_id?: string;
  vendor_id?: string;
  by_category?: boolean;
}

function payload(f: ReliabilityFilters) {
  const p: Record<string, unknown> = {};
  if (f.fy) p.fy = f.fy;
  if (f.category_id) p.category_id = f.category_id;
  if (f.vendor_id) p.vendor_id = f.vendor_id;
  if (f.by_category) p.by_category = true;
  return p;
}

export function useReliability(f: ReliabilityFilters, enabled = true) {
  useRealtimeInvalidate(["job_assignments", "commitment_revisions", "app_settings"], ["reliability"]);
  return useQuery({
    queryKey: ["reliability", f],
    enabled,
    queryFn: async () => unwrap(await supabase.rpc("vendor_reliability", { p: payload(f) })) as ReliabilityResult,
  });
}

const LABEL_TONE = { Excellent: "green", Good: "blue", Average: "amber", "Needs Improvement": "red" } as const;

export function ScoreLabelBadge({ label }: { label: ReliabilityRow["label"] }) {
  if (!label) return null;
  return <Badge tone={LABEL_TONE[label]}>{label}</Badge>;
}

/** Thin meter (track = lighter step of the same blue) + number + label; or the reason there is no score. */
export function ScoreCell({ row, compact }: { row: ReliabilityRow; compact?: boolean }) {
  if (row.score === null) {
    return (
      <span className="text-xs text-slate-600">
        {row.status === "insufficient_jobs"
          ? `Insufficient data (${row.eligible_jobs} of ${row.min_eligible_jobs} jobs)`
          : `Not enough factors with data (${row.factors_used} of ${row.min_factors})`}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      {!compact && (
        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-brand-100" aria-hidden>
          <span className="block h-full rounded-full bg-brand-600" style={{ width: `${Math.max(0, Math.min(100, row.score))}%` }} />
        </span>
      )}
      <span className="font-semibold tabular-nums text-slate-900">{row.score.toFixed(1)}</span>
      <ScoreLabelBadge label={row.label} />
    </span>
  );
}

export const BUCKET_LABEL: Record<ReliabilityBucket, string> = {
  completed: "Returned",
  vendor_cancelled: "Cancelled: vendor-caused",
  other_cancelled: "Cancelled: not vendor-caused",
  unclassified_cancelled: "Cancelled: reason not classified",
  open: "With vendor",
  closed_no_return: "Closed without return",
};

const SHORT: Record<ReliabilityFactor, string> = {
  on_time: "On-time",
  quality: "Quality",
  delay: "Delay",
  stability: "Stability",
  completion_time: "Completion",
  vendor_cancellation: "Cancellation",
};

export function FactorTable({ row }: { row: ReliabilityRow }) {
  return (
    <Table>
      <thead>
        <tr>
          <th className={th}>Factor</th>
          <th className={`${th} text-right`}>Weight set</th>
          <th className={`${th} text-right`}>Weight used</th>
          <th className={`${th} text-right`}>Factor score</th>
          <th className={`${th} text-right`}>Jobs</th>
          <th className={th}>How it was measured</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {row.factors.map((f) => (
          <tr key={f.key} className={f.used ? "" : "text-slate-400"}>
            <td className={cx(td, !f.used && "text-slate-500")}>{RELIABILITY_FACTOR_LABELS[f.key]}</td>
            <td className={`${td} text-right tabular-nums`}>{f.weight}%</td>
            <td className={`${td} text-right tabular-nums`}>{f.used && row.weight_used > 0 ? `${((f.weight * 100) / row.weight_used).toFixed(1)}%` : "not used"}</td>
            <td className={`${td} text-right tabular-nums`}>{f.score === null ? "—" : f.score.toFixed(1)}</td>
            <td className={`${td} text-right tabular-nums`}>{f.jobs}</td>
            <td className={cx(td, "text-xs", !f.used && "text-slate-500")}>{f.note}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="bg-slate-50">
          <td className={`${td} font-semibold`} colSpan={2}>
            Reliability score
          </td>
          <td className={`${td} text-right tabular-nums`}>{row.weight_used}% → 100%</td>
          <td className={`${td} text-right font-semibold tabular-nums`}>{row.score === null ? "—" : row.score.toFixed(1)}</td>
          <td className={td} colSpan={2}>
            {row.score === null ? <ScoreCell row={row} /> : <ScoreLabelBadge label={row.label} />}
          </td>
        </tr>
      </tfoot>
    </Table>
  );
}

function Measure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-slate-200 p-2.5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-900">{value}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
const days = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} days`);

export function MeasureGrid({ row }: { row: ReliabilityRow }) {
  const m = row.measures;
  const c = row.counts;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Measure label="On-time delivery" value={pct(m.on_time_pct)} hint={`${c.on_time} of ${c.committed_completed} returned jobs with a committed date`} />
      <Measure label="Average delay when late" value={days(m.avg_delay_when_late)} hint={`vs original date · ${days(m.avg_delay_when_late_vs_latest)} vs latest`} />
      <Measure label="Total delay days" value={String(m.total_delay_days)} hint={`${c.late} late returns (vs original date)`} />
      <Measure label="Overdue now" value={`${c.overdue_now} of ${c.open_committed}`} hint={m.overdue_now_pct === null ? "no open jobs with a date" : `${pct(m.overdue_now_pct)} of open jobs`} />
      <Measure label="Commitment revisions" value={`${m.revisions} (${m.revisions_vendor} by vendor)`} hint={`${m.revised_jobs} of ${m.committed_jobs} jobs revised${m.frequent_reviser ? " · frequent" : ""}`} />
      <Measure label="Average completion time" value={days(m.avg_days_taken)} hint="date given to return" />
      <Measure label="Quality acceptance" value={pct(m.quality_acceptance_pct)} hint={m.pieces_inspected ? `${m.pieces_accepted} of ${m.pieces_inspected} inspected pieces` : "no inspected pieces yet"} />
      <Measure label="Rework / rejection" value={pct(m.rework_rejection_pct)} hint={m.pieces_inspected ? `${m.pieces_rejected} rejected, ${m.pieces_rework} rework` : "no inspected pieces yet"} />
    </div>
  );
}

export function CancellationList({ row }: { row: ReliabilityRow }) {
  if (!row.cancel_reasons.length) return <p className="text-sm text-slate-600">No cancellations in this period.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {row.cancel_reasons.map((r) => (
        <li key={r.code} className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums font-semibold">{r.count}×</span> {r.label}
          {r.vendor_caused ? <Badge tone="red">Vendor-caused: counted once, in the cancellation factor</Badge> : <Badge>Not vendor-caused: excluded</Badge>}
        </li>
      ))}
    </ul>
  );
}

export function ReliabilityDetail({
  vendorId,
  vendorName,
  filters,
  dateFormat,
  open,
  onClose,
}: {
  vendorId: string;
  vendorName: string;
  filters: ReliabilityFilters;
  dateFormat: DateFormat;
  open: boolean;
  onClose: () => void;
}) {
  const f = { fy: filters.fy, category_id: filters.category_id };
  const score = useReliability({ ...f, vendor_id: vendorId }, open);
  const jobs = useQuery({
    queryKey: ["reliability-jobs", vendorId, f],
    enabled: open,
    queryFn: async () => unwrap(await supabase.rpc("vendor_reliability_jobs", { p_vendor_id: vendorId, p: payload(f) })) as ReliabilityJob[],
  });
  const [exportError, setExportError] = useState<string | null>(null);
  const row = score.data?.rows[0];

  async function exportJobs() {
    setExportError(null);
    try {
      const sheet: ExportSheet<ReliabilityJob> = {
        name: "Jobs counted",
        title: `${vendorName} - jobs used for the reliability score${f.fy ? ` (FY ${f.fy})` : ""}`,
        columns: [
          { header: "Job No", value: (j) => j.job_no },
          { header: "Part", value: (j) => j.part_label, width: 30 },
          { header: "Category", value: (j) => j.category_name },
          { header: "Given", value: (j) => j.dispatched_on, format: "date" },
          { header: "Original commitment", value: (j) => j.original_commitment_date, format: "date" },
          { header: "Latest commitment", value: (j) => j.current_commitment_date, format: "date" },
          { header: "Returned", value: (j) => j.completed_on, format: "date" },
          { header: "Cancelled", value: (j) => j.cancelled_on, format: "date" },
          { header: "Outcome", value: (j) => BUCKET_LABEL[j.bucket] },
          { header: "Cancellation reason", value: (j) => j.cancel_reason_label, width: 30 },
          { header: "Days taken", value: (j) => j.days_taken, format: "int" },
          { header: "Days late vs original", value: (j) => j.late_days, format: "int" },
          { header: "Days late vs latest", value: (j) => j.late_days_current, format: "int" },
          { header: "Revisions (all)", value: (j) => j.revisions, format: "int" },
          { header: "Revisions by vendor", value: (j) => j.vendor_revisions, format: "int" },
          { header: "Category usual days (median)", value: (j) => j.category_median_days },
          { header: "Used in factors", value: (j) => j.used_in.map((k) => RELIABILITY_FACTOR_LABELS[k]).join(", "), width: 40 },
          { header: "Not counted because", value: (j) => j.excluded_because, width: 40 },
        ],
        rows: jobs.data ?? [],
      };
      await downloadWorkbook(`CESS-Reliability-${vendorName.replace(/[^A-Za-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.xlsx`, [sheet]);
      await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "vendors", p_details: { what: "reliability jobs", vendor: vendorName, rows: jobs.data?.length ?? 0 } });
    } catch (e) {
      setExportError(toAppError(e).message);
    }
  }

  return (
    <Modal open={open} title={`How the score was calculated · ${vendorName}`} onClose={onClose} wide>
      {score.isLoading || jobs.isLoading ? (
        <Spinner />
      ) : score.error || jobs.error ? (
        <Alert tone="error">{toAppError(score.error ?? jobs.error).message}</Alert>
      ) : !row ? (
        <Alert tone="info">No jobs with this vendor in the selected period.</Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ScoreCell row={row} />
            <span className="text-xs text-slate-500">
              {plural(row.eligible_jobs, "eligible job", "eligible jobs")} ({row.counts.completed} returned + {plural(row.counts.vendor_cancelled, "vendor-caused cancellation", "vendor-caused cancellations")}) · minimum {row.min_eligible_jobs}
              {f.fy ? ` · FY ${f.fy}` : " · all years"}
            </span>
          </div>
          <FactorTable row={row} />
          <p className="text-xs text-slate-500">
            Score = sum of (weight used × factor score) ÷ 100. Factors without data are left out and the remaining weights are scaled up to 100%, as shown in "Weight used".
            Every job counts in one group only: returned jobs feed the delivery factors, vendor-caused cancellations feed only the cancellation factor, and everything else is excluded.
          </p>
          <MeasureGrid row={row} />
          <div>
            <h3 className="mb-1 text-sm font-semibold text-slate-800">Cancellations (shown separately)</h3>
            <CancellationList row={row} />
          </div>
          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800">Every job with this vendor ({jobs.data?.length ?? 0})</h3>
              <Button variant="secondary" onClick={exportJobs}>
                <Download className="h-4 w-4" /> Export to Excel
              </Button>
            </div>
            {exportError && <Alert tone="error">{exportError}</Alert>}
            <Table>
              <thead>
                <tr>
                  <th className={th}>Job</th>
                  <th className={th}>Given → original / latest</th>
                  <th className={th}>Outcome</th>
                  <th className={th}>Used in</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(jobs.data ?? []).map((j) => (
                  <tr key={j.assignment_id}>
                    <td className={td}>
                      <Link to={`/jobs/${j.job_id}`} className="font-medium text-brand-700 hover:underline" onClick={onClose}>
                        {j.job_no}
                      </Link>
                      <p className="text-xs text-slate-500">{j.part_label}</p>
                    </td>
                    <td className={`${td} whitespace-nowrap text-xs`}>
                      {formatDate(j.dispatched_on, dateFormat)}
                      <br />
                      {j.original_commitment_date ? formatDate(j.original_commitment_date, dateFormat) : "no date"}
                      {j.current_commitment_date && j.current_commitment_date !== j.original_commitment_date && <> / {formatDate(j.current_commitment_date, dateFormat)}</>}
                      {j.revisions > 0 && <span className="block text-amber-700">{j.revisions} revision{j.revisions === 1 ? "" : "s"} ({j.vendor_revisions} by vendor)</span>}
                    </td>
                    <td className={`${td} text-xs`}>
                      <span className="font-medium text-slate-800">{BUCKET_LABEL[j.bucket]}</span>
                      {j.completed_on && <> {formatDate(j.completed_on, dateFormat)} · {j.days_taken} days</>}
                      {j.late_days !== null && j.late_days > 0 && <span className="block text-red-700">{j.late_days} days late vs original{j.late_days_current ? `, ${j.late_days_current} vs latest` : ""}</span>}
                      {j.cancel_reason_label && <span className="block text-slate-600">{j.cancel_reason_label}</span>}
                      {j.overdue_now && <span className="block text-red-700">Overdue now</span>}
                    </td>
                    <td className={`${td} text-xs`}>
                      {j.used_in.length ? (
                        <span className="flex flex-wrap gap-1">
                          {j.used_in.map((k) => (
                            <Badge key={k}>{SHORT[k]}</Badge>
                          ))}
                        </span>
                      ) : null}
                      {j.excluded_because && <span className="mt-1 block text-slate-500">{j.excluded_because}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}
    </Modal>
  );
}
