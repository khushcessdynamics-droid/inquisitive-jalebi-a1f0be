import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { History, Plus } from "lucide-react";
import { formatDate } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import type { QuotationListRow, QuotationRequestRow } from "../../lib/phase5Types";
import { useDateFormat, useRealtimeInvalidate } from "../../hooks/data";
import { Money } from "../../components/jobs";
import { QUOTE_STATUS, RequestDialog } from "../../components/quotes";
import { Alert, Badge, Button, EmptyState, PageHeader, Spinner, Table, cx, td, th } from "../../components/ui";

const TABS: Array<{ key: QuotationRequestRow["status"] | "all"; label: string }> = [
  { key: "open", label: "Collecting quotations" },
  { key: "decided", label: "Vendor chosen" },
  { key: "job_created", label: "Job created" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

export function QuotesPage() {
  const { can } = useAuth();
  const dateFormat = useDateFormat();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "open") as (typeof TABS)[number]["key"];
  const [creating, setCreating] = useState(false);
  useRealtimeInvalidate(["quotation_requests", "vendor_quotations"], ["quotation-list"]);
  const list = useQuery({
    queryKey: ["quotation-list", tab],
    queryFn: async () => unwrap(await supabase.rpc("quotation_requests_list", { p_status: tab === "all" ? null : tab })) as QuotationListRow[],
  });

  return (
    <>
      <PageHeader
        title="Vendor Cost Comparison"
        description="Compare quotations for the same part and category before giving a job. The system can recommend; you always choose."
        actions={
          <>
            <Link to="/quotes/history" className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
              <History className="h-4 w-4" /> Price history
            </Link>
            {can("quotations.manage") && (
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New comparison
              </Button>
            )}
          </>
        }
      />
      <div className="mb-3 flex flex-wrap gap-1 border-b border-slate-200" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              tab === t.key ? "border-brand-700 text-brand-800" : "border-transparent text-slate-600 hover:text-slate-900",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : list.error ? (
        <Alert tone="error">{toAppError(list.error).message}</Alert>
      ) : !list.data?.length ? (
        <EmptyState title="No comparisons here">{can("quotations.manage") ? 'Start one with "New comparison".' : null}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Comparison</th>
              <th className={th}>Part / category</th>
              <th className={`${th} text-right`}>Qty</th>
              <th className={th}>Required by</th>
              <th className={`${th} text-right`}>Quotes</th>
              <th className={`${th} text-right`}>Lowest total</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.data.map((r) => (
              <tr key={r.id}>
                <td className={td}>
                  <Link to={`/quotes/${r.id}`} className="font-medium text-brand-700 hover:underline">
                    {r.request_no}
                  </Link>
                  <p className="text-xs text-slate-500">{formatDate(r.created_at.slice(0, 10), dateFormat)}</p>
                </td>
                <td className={td}>
                  {r.part_label}
                  <p className="text-xs text-slate-500">{r.category_name}</p>
                </td>
                <td className={`${td} text-right tabular-nums`}>{r.qty}</td>
                <td className={`${td} whitespace-nowrap`}>{r.required_by ? formatDate(r.required_by, dateFormat) : "—"}</td>
                <td className={`${td} text-right tabular-nums`}>{r.quotes}</td>
                <td className={`${td} text-right`}>
                  <Money value={r.lowest} />
                </td>
                <td className={td}>
                  <Badge tone={QUOTE_STATUS[r.status].tone}>{QUOTE_STATUS[r.status].label}</Badge>
                  {r.selected_vendor && <p className="mt-0.5 text-xs text-slate-600">{r.selected_vendor}</p>}
                  {r.job_id && (
                    <Link to={`/jobs/${r.job_id}`} className="block text-xs text-brand-700 hover:underline">
                      {r.job_no}
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <RequestDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
