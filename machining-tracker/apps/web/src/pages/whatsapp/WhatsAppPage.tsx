import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { formatDate } from "@cess/shared";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import type { JobRegisterRow } from "../../lib/types";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { useVendors } from "../../hooks/master";
import { StatusBadge } from "../../components/jobs";
import { WhatsAppDialog, WhatsAppHistory, suggestTemplate } from "../../components/whatsapp";
import { Alert, Button, Card, EmptyState, Field, PageHeader, Select, Spinner, Table, cx, td, th } from "../../components/ui";

const FOLLOW_UP = ["Overdue", "Due Today", "Due Soon", "Commitment Date Missing", "Partially Returned"];

export function WhatsAppPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "history" ? "history" : "followups";
  const dateFormat = useDateFormat();
  const vendors = useVendors();
  const [vendor, setVendor] = useState("");
  const [wa, setWa] = useState<{ jobId: string; template: string } | null>(null);
  useRealtimeInvalidate(["jobs", "job_assignments", "material_returns"], ["wa-followups"]);
  const followups = useQuery({
    queryKey: ["wa-followups"],
    enabled: tab === "followups",
    queryFn: async () =>
      unwrap(await supabase.from("job_register").select("*").is("archived_at", null).in("status", FOLLOW_UP).order("current_commitment_date", { ascending: true, nullsFirst: false }).limit(300)) as unknown as JobRegisterRow[],
  });
  const order = (s: string) => FOLLOW_UP.indexOf(s);
  const rows = [...(followups.data ?? [])].sort((a, b) => order(a.status) - order(b.status));

  return (
    <>
      <PageHeader
        title="WhatsApp Communication"
        description="Click-to-chat: WhatsApp opens with the prepared message and you press Send. Messages are recorded as opened; only you can mark them as sent."
      />
      <div className="mb-4 flex gap-1 border-b border-slate-200" role="tablist">
        {(
          [
            ["followups", "Follow-ups due"],
            ["history", "Message history"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setParams({ tab: k }, { replace: true })}
            className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === k ? "border-brand-700 text-brand-800" : "border-transparent text-slate-600 hover:text-slate-900")}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "followups" ? (
        followups.isLoading ? (
          <Spinner />
        ) : followups.error ? (
          <Alert tone="error">{toAppError(followups.error).message}</Alert>
        ) : !rows.length ? (
          <EmptyState title="Nothing to follow up">No jobs are overdue, due soon, missing a committed date or partially returned.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Job</th>
                <th className={th}>Status</th>
                <th className={th}>Vendor</th>
                <th className={th}>Committed</th>
                <th className={th}>
                  <span className="sr-only">WhatsApp</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={td}>
                    <Link to={`/jobs/${r.id}`} className="font-medium text-brand-700 hover:underline">
                      {r.job_no}
                    </Link>
                    <p className="text-xs text-slate-500">{r.part_label}</p>
                  </td>
                  <td className={td}>
                    <StatusBadge status={r.status} />
                    {r.status === "Overdue" && r.delay_days_current !== null && <p className="text-xs text-red-700">{r.delay_days_current} days late</p>}
                  </td>
                  <td className={td}>{r.vendor_name}</td>
                  <td className={`${td} whitespace-nowrap`}>{r.current_commitment_date ? formatDate(r.current_commitment_date, dateFormat) : "—"}</td>
                  <td className={td}>
                    <Button variant="secondary" className="whitespace-nowrap px-2.5 py-1" onClick={() => setWa({ jobId: r.id, template: suggestTemplate(r.status, { hasCommitment: !!r.current_commitment_date }) })}>
                      <MessageCircle className="h-4 w-4" /> WhatsApp
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )
      ) : (
        <div className="space-y-3">
          <Card>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Vendor" htmlFor="wa-v">
                <Select id="wa-v" value={vendor} onChange={(e) => setVendor(e.target.value)}>
                  <option value="">All vendors</option>
                  {(vendors.data ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>
          <Card>
            <WhatsAppHistory vendorId={vendor || undefined} dateFormat={dateFormat} limit={300} />
          </Card>
        </div>
      )}
      {wa && <WhatsAppDialog jobId={wa.jobId} initialTemplate={wa.template} open onClose={() => setWa(null)} />}
    </>
  );
}
