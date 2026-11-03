import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { formatDate } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { useDateFormat } from "../../hooks/data";
import { useCategories, useVendors } from "../../hooks/master";
import { Money } from "../../components/jobs";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, Table, td, th } from "../../components/ui";
import { VendorDialog } from "./VendorsPage";

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
      <p className="mb-4 text-xs text-slate-500">
        On-time %, average delay, quality acceptance and the six-factor reliability score are added with the Vendor Reliability module (next phase).
      </p>
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
      <VendorDialog vendor={vendor} open={editing} onClose={() => setEditing(false)} />
    </>
  );
}
