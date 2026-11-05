import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { formatDate, formatINR, recentFinancialYears, todayIST } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { useDateFormat } from "../../hooks/data";
import { useCategories, useVendors } from "../../hooks/master";
import { Money } from "../../components/jobs";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, Table, td, th } from "../../components/ui";
import { VendorDialog } from "./VendorsPage";
import { CancellationList, MeasureGrid, ReliabilityDetail, ScoreCell, plural, useReliability } from "../../components/reliability";
import type { CommitmentRevisionRow, ReliabilityRow } from "../../lib/phase5Types";
import { StatementDialog } from "../../components/vendorStatement";
import { WhatsAppHistory } from "../../components/whatsapp";

interface Summary {
  assignments: number;
  open: number;
  overdue: number;
  completed: number;
  cancelled_vendor_caused: number;
  cancelled_other: number;
  business_amount: number;
  first_job: string | null;
  last_job: string | null;
}

interface VendorJob {
  id: string;
  dispatched_on: string;
  state: string;
  amount: number | null;
  original_commitment_date: string | null;
  completed_on: string | null;
  cancelled_on: string | null;
  job: { id: string; job_no: string; part_label: string } | null;
  reason: { label: string; vendor_related: boolean } | null;
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${tone ?? "text-slate-900"}`}>{value}</p>
    </div>
  );
}

export function VendorDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const dateFormat = useDateFormat();
  const vendors = useVendors();
  const categories = useCategories();
  const [editing, setEditing] = useState(false);
  const canScore = can("reliability.view");
  const fy = recentFinancialYears(todayIST(), 1)[0]!;
  const [scoreFy, setScoreFy] = useState<string>("");
  const overall = useReliability({ vendor_id: id, fy: scoreFy || undefined }, canScore);
  const perCategory = useReliability({ vendor_id: id, fy: scoreFy || undefined, by_category: true }, canScore);
  const [detail, setDetail] = useState<null | { categoryId?: string; name: string }>(null);
  const [statement, setStatement] = useState(false);
  const payments = useQuery({
    queryKey: ["payment-summary", "vendor", id],
    enabled: can("payments.view"),
    queryFn: async () =>
      ((unwrap(await supabase.rpc("vendor_payment_summary", { p: {} })) as Array<{ vendor_id: string; total_payable: number; amount_paid: number; outstanding: number; accounts: number }>).find(
        (r) => r.vendor_id === id,
      ) ?? null),
  });
  const revisions = useQuery({
    queryKey: ["vendor-revisions", id],
    queryFn: async () => unwrap(await supabase.from("commitment_history").select("*").eq("vendor_id", id).order("created_at", { ascending: false }).limit(50)) as CommitmentRevisionRow[],
  });
  const vendor = vendors.data?.find((v) => v.id === id);
  const summary = useQuery({
    queryKey: ["vendor-summary", id],
    queryFn: async () => unwrap(await supabase.rpc("vendor_summary", { p_vendor_id: id })) as Summary,
  });
  const jobs = useQuery({
    queryKey: ["vendor-jobs", id],
    queryFn: async () =>
      unwrap(
        await supabase
          .from("job_assignments")
          .select("id,dispatched_on,state,amount,original_commitment_date,completed_on,cancelled_on, job:jobs(id,job_no,part_label), reason:cancel_reason_codes(label,vendor_related)")
          .eq("vendor_id", id)
          .order("dispatched_on", { ascending: false })
          .limit(100),
      ) as unknown as VendorJob[],
  });

  if (vendors.isLoading) return <Spinner />;
  if (!vendor) return <Alert tone="warning" title="Vendor not found">It does not exist or you do not have access.</Alert>;
  const s = summary.data;
  const catName = Object.fromEntries((categories.data ?? []).map((c) => [c.id, c.name]));
  return (
    <>
      <PageHeader
        title={vendor.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {vendor.vendor_code}
            {vendor.company_name && <> · {vendor.company_name}</>}
            {vendor.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
          </span>
        }
        actions={
          can("vendors.manage") && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Edit vendor
            </Button>
          )
        }
      />
      {summary.error && <Alert tone="error">{toAppError(summary.error).message}</Alert>}
      {s && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <Stat label="Jobs given" value={s.assignments} />
          <Stat label="Open now" value={s.open} />
          <Stat label="Overdue now" value={s.overdue} tone={s.overdue ? "text-red-700" : undefined} />
          <Stat label="Completed" value={s.completed} />
          <Stat label="Cancelled (vendor-caused)" value={s.cancelled_vendor_caused} tone={s.cancelled_vendor_caused ? "text-red-700" : undefined} />
          <Stat label="Cancelled (other reasons)" value={s.cancelled_other} />
          <Stat label="Business (excl. cancelled)" value={new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(s.business_amount)} />
        </div>
      )}
      {can("payments.view") && (
        <Card
          className="mb-4"
          title="Payments"
          actions={
            <Button variant="secondary" onClick={() => setStatement(true)}>
              Payment statement
            </Button>
          }
        >
          {payments.isLoading ? (
            <Spinner />
          ) : !payments.data ? (
            <p className="text-sm text-slate-600">No job amounts or payments recorded for this vendor.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Total payable" value={formatINR(payments.data.total_payable)} />
              <Stat label="Total paid" value={formatINR(payments.data.amount_paid)} />
              <Stat label="Outstanding" value={formatINR(payments.data.outstanding)} tone={payments.data.outstanding > 0 ? "text-red-700" : undefined} />
              <Stat label="Job accounts" value={payments.data.accounts} />
            </div>
          )}
        </Card>
      )}
      {statement && <StatementDialog vendorId={id} vendorName={vendor.name} dateFormat={dateFormat} onClose={() => setStatement(false)} />}
      {canScore && (
        <Card
          className="mb-4"
          title="Reliability score"
          actions={
            <span className="flex items-center gap-2">
              <label htmlFor="vd-fy" className="text-xs text-slate-500">
                Period
              </label>
              <select id="vd-fy" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={scoreFy} onChange={(e) => setScoreFy(e.target.value)}>
                <option value="">All years</option>
                {recentFinancialYears(todayIST(), 6).map((y) => (
                  <option key={y} value={y}>
                    FY {y}
                  </option>
                ))}
              </select>
              <Link to={`/vendors/reliability?fy=${scoreFy || fy}`} className="text-xs font-medium text-brand-700 hover:underline">
                Compare vendors
              </Link>
            </span>
          }
        >
          {overall.isLoading ? (
            <Spinner />
          ) : overall.error ? (
            <Alert tone="error">{toAppError(overall.error).message}</Alert>
          ) : !overall.data?.rows[0] ? (
            <p className="text-sm text-slate-600">No jobs with this vendor in this period, so there is no score.</p>
          ) : (
            <VendorScore
              row={overall.data.rows[0]}
              categories={perCategory.data?.rows ?? []}
              onDetail={(categoryId, name) => setDetail({ categoryId, name })}
            />
          )}
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Contact and details">
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-slate-500">Contact person</dt><dd>{vendor.contact_person || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">Mobile</dt><dd>{vendor.mobile || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">WhatsApp</dt><dd>{vendor.wa_number ? `${vendor.wa_country_code} ${vendor.wa_number}` : "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">Email</dt><dd>{vendor.email || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">GST number</dt><dd>{vendor.gst_no || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">Payment terms</dt><dd>{vendor.payment_terms || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">Address</dt><dd className="whitespace-pre-line">{vendor.address || "—"}</dd></div>
            <div>
              <dt className="text-xs text-slate-500">Work categories</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {(vendor.vendor_categories ?? []).map((c) => <Badge key={c.work_category_id}>{catName[c.work_category_id]}</Badge>)}
              </dd>
            </div>
            {vendor.remarks && <div><dt className="text-xs text-slate-500">Notes</dt><dd>{vendor.remarks}</dd></div>}
          </dl>
        </Card>
        <Card title="Jobs with this vendor (latest 100)" className="lg:col-span-2">
          {jobs.isLoading ? (
            <Spinner />
          ) : !jobs.data?.length ? (
            <EmptyState title="No jobs yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Job</th>
                  <th className={th}>Given</th>
                  <th className={th}>Committed</th>
                  <th className={th}>Outcome</th>
                  <th className={th}>Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.data.map((a) => (
                  <tr key={a.id}>
                    <td className={td}>
                      {a.job && (
                        <Link to={`/jobs/${a.job.id}`} className="font-medium text-brand-700 hover:underline">
                          {a.job.job_no}
                        </Link>
                      )}
                      <p className="text-xs text-slate-500">{a.job?.part_label}</p>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{formatDate(a.dispatched_on, dateFormat)}</td>
                    <td className={`${td} whitespace-nowrap`}>{a.original_commitment_date ? formatDate(a.original_commitment_date, dateFormat) : "—"}</td>
                    <td className={td}>
                      {a.state === "open" && <Badge tone="blue">With vendor</Badge>}
                      {a.state === "completed" && <Badge tone="green">Returned {a.completed_on ? formatDate(a.completed_on, dateFormat) : ""}</Badge>}
                      {a.state === "cancelled" && (
                        <span className="text-xs">
                          <Badge tone={a.reason?.vendor_related ? "red" : "slate"}>Cancelled</Badge> {a.reason?.label}
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      <Money value={a.amount} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <Card className="mt-4" title={`Commitment revisions (${revisions.data?.length ?? 0}${(revisions.data?.length ?? 0) === 50 ? "+" : ""})`}>
        {revisions.isLoading ? (
          <Spinner />
        ) : !revisions.data?.length ? (
          <p className="text-sm text-slate-600">This vendor has not revised any committed date.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Job</th>
                <th className={th}>Revision</th>
                <th className={th}>Change</th>
                <th className={th}>Requested by</th>
                <th className={th}>Reason</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {revisions.data.map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <Link to={`/jobs/${r.job_id}`} className="font-medium text-brand-700 hover:underline">
                      {r.job_no}
                    </Link>
                    <p className="text-xs text-slate-500">{r.part_label}</p>
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    #{r.revision_no} · {formatDate(r.changed_on, dateFormat)}
                  </td>
                  <td className={`${td} whitespace-nowrap text-xs`}>
                    {formatDate(r.previous_date, dateFormat)} → <strong>{formatDate(r.new_date, dateFormat)}</strong>
                    <span className="block text-slate-500">original {formatDate(r.original_date, dateFormat)} ({r.days_from_original > 0 ? "+" : ""}{r.days_from_original} days)</span>
                  </td>
                  <td className={td}>{r.requested_by === "vendor" ? <Badge tone="amber">Vendor</Badge> : <Badge>CESS</Badge>}</td>
                  <td className={`${td} text-xs`}>
                    {r.reason}
                    <span className="block text-slate-500">{r.changed_by_name}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {can("whatsapp.send") && (
        <Card className="mt-4" title="WhatsApp with this vendor">
          <WhatsAppHistory vendorId={id} dateFormat={dateFormat} limit={30} />
        </Card>
      )}
      {detail && (
        <ReliabilityDetail
          vendorId={id}
          vendorName={`${vendor.name}${detail.categoryId ? ` · ${detail.name}` : ""}`}
          filters={{ fy: scoreFy || undefined, category_id: detail.categoryId }}
          dateFormat={dateFormat}
          open
          onClose={() => setDetail(null)}
        />
      )}
      <VendorDialog vendor={vendor} open={editing} onClose={() => setEditing(false)} />
    </>
  );
}

function VendorScore({ row, categories, onDetail }: { row: ReliabilityRow; categories: ReliabilityRow[]; onDetail: (categoryId: string | undefined, name: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Overall</p>
          <div className="mt-1 text-lg">
            <ScoreCell row={row} />
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {plural(row.eligible_jobs, "eligible job", "eligible jobs")} ({row.counts.completed} returned, {plural(row.counts.vendor_cancelled, "vendor-caused cancellation", "vendor-caused cancellations")}) of {row.counts.total} given
          </p>
        </div>
        <Button variant="secondary" onClick={() => onDetail(undefined, "")}>
          How this score was calculated
        </Button>
      </div>
      <MeasureGrid row={row} />
      {categories.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold text-slate-800">By machining category</h3>
          <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
            {categories.map((c) => (
              <li key={c.category_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="font-medium text-slate-800">{c.category_name}</span>
                <span className="flex flex-wrap items-center gap-3">
                  <ScoreCell row={c} />
                  <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => onDetail(c.category_id ?? undefined, c.category_name ?? "")}>
                    How calculated
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-sm font-semibold text-slate-800">Cancellations</h3>
        <CancellationList row={row} />
      </div>
    </div>
  );
}
