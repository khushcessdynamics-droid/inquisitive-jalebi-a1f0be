import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { CheckCircle2, ClipboardPlus, Download, Pencil, Plus, RotateCcw, XCircle } from "lucide-react";
import { formatDate, formatDateTimeIST, formatINR } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { downloadWorkbook, type ExportSheet } from "../../lib/excel";
import type { ComparedQuote } from "../../lib/phase5Types";
import { PartJobs, PartQuotes } from "../../components/priceTables";
import { useDateFormat } from "../../hooks/data";
import { Money } from "../../components/jobs";
import { ChooseVendorDialog, CreateJobFromQuoteDialog, QUOTE_STATUS, QuoteDialog, RequestDialog, useComparison } from "../../components/quotes";
import { DeliveryChart, TotalCostChart } from "../../components/quoteCharts";
import { ScoreLabelBadge } from "../../components/reliability";
import { Alert, Badge, Button, Card, EmptyState, PageHeader, ReasonDialog, Spinner, Table, td, th } from "../../components/ui";

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-3">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const signed = (n: number | null, suffix = "%") => (n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1)}${suffix}`);

export function QuoteDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const dateFormat = useDateFormat();
  const cmp = useComparison(id);
  const [dialog, setDialog] = useState<null | "edit" | "add" | "close" | "reopen" | "job">(null);
  const [editQuote, setEditQuote] = useState<ComparedQuote | null>(null);
  const [withdraw, setWithdraw] = useState<ComparedQuote | null>(null);
  const [choose, setChoose] = useState<ComparedQuote | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  if (cmp.isLoading) return <Spinner />;
  if (cmp.error) return <Alert tone="error">{toAppError(cmp.error).message}</Alert>;
  const c = cmp.data!;
  const r = c.request;
  const manage = can("quotations.manage");
  const isOpen = r.status === "open";
  const rec = c.quotes.find((q) => q.id === c.recommendation.quotation_id) ?? null;
  const selected = c.quotes.find((q) => q.id === r.selected_quotation_id) ?? null;
  const recommendedAtDecision = c.quotes.find((q) => q.id === r.recommended_quotation_id) ?? null;
  const st = c.stats;

  async function exportExcel() {
    setExportError(null);
    try {
      const sheet: ExportSheet<ComparedQuote> = {
        name: "Comparison",
        title: `${r.request_no} - ${r.part_label} - ${r.category_name} - ${r.qty} pcs`,
        columns: [
          { header: "Vendor", value: (q) => q.vendor_name, width: 26 },
          { header: "Quotation date", value: (q) => q.quote_date, format: "date" },
          { header: "Reference", value: (q) => q.quote_ref },
          { header: "Per-part rate", value: (q) => q.per_part, format: "inr" },
          { header: `Total for ${r.qty} pcs`, value: (q) => q.total, format: "inr" },
          { header: "Difference vs lowest", value: (q) => q.diff_vs_lowest, format: "inr" },
          { header: "Difference vs lowest %", value: (q) => q.diff_vs_lowest_pct },
          { header: "Difference vs average %", value: (q) => q.diff_vs_average_pct },
          { header: "Expected delivery days", value: (q) => q.delivery_days, format: "int" },
          { header: "Reliability score", value: (q) => q.reliability.score },
          { header: "Reliability label", value: (q) => q.reliability.label },
          { header: "Value score", value: (q) => q.value_score },
          { header: "Recommended", value: (q) => (q.id === c.recommendation.quotation_id ? "Yes" : "") },
          { header: "Chosen", value: (q) => (q.id === r.selected_quotation_id ? "Yes" : "") },
          { header: "Remarks", value: (q) => q.remarks, width: 30 },
        ],
        rows: c.quotes,
      };
      const summary: ExportSheet<{ k: string; v: string | number | null }> = {
        name: "Summary",
        columns: [
          { header: "Item", value: (x) => x.k, width: 30 },
          { header: "Value", value: (x) => x.v, width: 40 },
        ],
        rows: [
          { k: "Lowest quotation", v: st.lowest },
          { k: "Highest quotation", v: st.highest },
          { k: "Average quotation", v: st.average },
          { k: "Price difference (highest - lowest)", v: st.spread },
          { k: "Percentage difference", v: st.spread_pct === null ? null : `${st.spread_pct}%` },
          { k: "Recommended", v: rec?.vendor_name ?? c.recommendation.reason ?? "" },
          { k: "Chosen", v: selected?.vendor_name ?? "" },
          { k: "Reason for choice", v: r.decision_reason ?? "" },
        ],
      };
      await downloadWorkbook(`CESS-${r.request_no}-comparison.xlsx`, [sheet, summary]);
      await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "quotations", p_entity_id: r.id, p_details: { what: "cost comparison", request: r.request_no } });
    } catch (e) {
      setExportError(toAppError(e).message);
    }
  }

  return (
    <>
      <PageHeader
        title={`${r.request_no} · ${r.part_label}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={QUOTE_STATUS[r.status].tone}>{QUOTE_STATUS[r.status].label}</Badge>
            {r.category_name} · {r.qty} pcs{r.required_by ? ` · required by ${formatDate(r.required_by, dateFormat)}` : ""}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={exportExcel} disabled={!c.quotes.length}>
              <Download className="h-4 w-4" /> Export
            </Button>
            {manage && isOpen && (
              <>
                <Button variant="secondary" onClick={() => setDialog("edit")}>
                  <Pencil className="h-4 w-4" /> Edit requirement
                </Button>
                <Button onClick={() => setDialog("add")}>
                  <Plus className="h-4 w-4" /> Add quotation
                </Button>
              </>
            )}
            {manage && r.status === "decided" && can("jobs.create") && (
              <Button onClick={() => setDialog("job")}>
                <ClipboardPlus className="h-4 w-4" /> Create job
              </Button>
            )}
            {manage && (r.status === "decided" || r.status === "closed") && (
              <Button variant="secondary" onClick={() => setDialog("reopen")}>
                <RotateCcw className="h-4 w-4" /> Reopen
              </Button>
            )}
            {manage && (isOpen || r.status === "decided") && (
              <Button variant="ghost" onClick={() => setDialog("close")}>
                <XCircle className="h-4 w-4" /> Close
              </Button>
            )}
          </>
        }
      />
      {exportError && <div className="mb-3"><Alert tone="error">{exportError}</Alert></div>}
      {r.remarks && <p className="mb-3 text-sm text-slate-600">{r.remarks}</p>}
      {selected && (
        <div className="mb-4">
          <Alert tone={r.status === "job_created" ? "success" : "info"} title={`Vendor chosen: ${selected.vendor_name} (${formatINR(selected.total)})`}>
            {r.decided_by_name && r.decided_at && <>By {r.decided_by_name} on {formatDateTimeIST(r.decided_at, dateFormat)}. </>}
            {recommendedAtDecision && recommendedAtDecision.id !== selected.id && <>The recommendation was {recommendedAtDecision.vendor_name}. </>}
            {r.decision_reason && <>Reason: {r.decision_reason}. </>}
            {r.status === "job_created" && r.job_id ? (
              <Link to={`/jobs/${r.job_id}`} className="font-medium underline">
                Open job {r.job_no}
              </Link>
            ) : (
              <>No job has been created yet.</>
            )}
          </Alert>
        </div>
      )}
      {r.status === "closed" && <div className="mb-4"><Alert tone="warning" title="Closed">{r.closed_reason}</Alert></div>}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Quotations" value={st.count} />
        <Tile label="Lowest" value={st.lowest === null ? "—" : formatINR(st.lowest)} hint={st.lowest_per_part === null ? undefined : `${formatINR(st.lowest_per_part)} per part`} />
        <Tile label="Highest" value={st.highest === null ? "—" : formatINR(st.highest)} hint={st.highest_per_part === null ? undefined : `${formatINR(st.highest_per_part)} per part`} />
        <Tile label="Average" value={st.average === null ? "—" : formatINR(st.average)} hint={st.average_per_part === null ? undefined : `${formatINR(st.average_per_part)} per part`} />
        <Tile label="Price difference" value={st.spread === null ? "—" : formatINR(st.spread)} hint={st.spread_pct === null ? undefined : `highest is ${st.spread_pct.toFixed(1)}% above lowest`} />
      </div>

      <Card className="mt-4" title="Recommendation (advice only)">
        {!c.recommendation.available ? (
          <p className="text-sm text-slate-600">{c.recommendation.reason}</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
              <strong className="text-base">{rec?.vendor_name}</strong>
              <span className="text-slate-600">
                value score {rec?.value_score?.toFixed(1)} · {formatINR(rec?.total)}
                {rec?.delivery_days !== null ? ` · ${rec?.delivery_days} days` : ""}
              </span>
              {rec && !rec.is_lowest && <Badge tone="amber">Not the cheapest</Badge>}
            </p>
            <p className="text-slate-700">
              Weighted on price {c.recommendation.weights_used.price}%, reliability {c.recommendation.weights_used.reliability}%, delivery time {c.recommendation.weights_used.delivery}%. Price score = lowest ÷
              this total; delivery score = fastest ÷ these days; reliability = the vendor's score (category score when available).
            </p>
            {c.recommendation.left_out.map((m) => (
              <Alert key={m} tone="warning">
                {m}
              </Alert>
            ))}
            <p className="text-xs text-slate-500">{c.recommendation.note}</p>
          </div>
        )}
      </Card>

      <Card className="mt-4" title={`Quotations for ${r.qty} pcs`}>
        {!c.quotes.length ? (
          <EmptyState title="No quotations yet">{manage && isOpen ? 'Add each vendor\'s quotation with "Add quotation".' : null}</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Vendor</th>
                <th className={`${th} text-right`}>Per part</th>
                <th className={`${th} text-right`}>Total</th>
                <th className={`${th} text-right`}>vs lowest</th>
                <th className={`${th} text-right`}>vs average</th>
                <th className={`${th} text-right`}>Delivery</th>
                <th className={th}>Reliability</th>
                <th className={`${th} text-right`}>Value score</th>
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {c.quotes.map((q) => (
                <tr key={q.id} className={q.id === r.selected_quotation_id ? "bg-emerald-50/50" : undefined}>
                  <td className={td}>
                    <Link to={`/vendors/${q.vendor_id}`} className="font-medium text-brand-700 hover:underline">
                      {q.vendor_name}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {formatDate(q.quote_date, dateFormat)}
                      {q.quote_ref && ` · ${q.quote_ref}`}
                    </p>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {q.id === c.recommendation.quotation_id && <Badge tone="green">Recommended</Badge>}
                      {q.id === r.selected_quotation_id && <Badge tone="blue">Chosen</Badge>}
                      {q.is_lowest && <Badge>Lowest price</Badge>}
                      {q.is_highest && <Badge>Highest price</Badge>}
                      {q.is_fastest && <Badge>Fastest</Badge>}
                      {q.stale && <Badge tone="amber">Older than {c.settings.stale_quote_days} days</Badge>}
                    </span>
                    {q.remarks && <p className="mt-1 text-xs text-slate-600">{q.remarks}</p>}
                  </td>
                  <td className={`${td} text-right`}>
                    <Money value={q.per_part} />
                    {q.basis === "total" && <p className="text-xs text-slate-500">calculated</p>}
                  </td>
                  <td className={`${td} text-right font-medium`}>
                    <Money value={q.total} />
                    {q.basis === "per_part" && <p className="text-xs font-normal text-slate-500">calculated</p>}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {q.is_lowest ? "lowest" : <>+{formatINR(q.diff_vs_lowest)}<span className="block text-xs text-slate-500">{signed(q.diff_vs_lowest_pct)}</span></>}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>{signed(q.diff_vs_average_pct)}</td>
                  <td className={`${td} text-right`}>
                    {q.delivery_days === null ? <span className="text-slate-400">not stated</span> : `${q.delivery_days} days`}
                    {q.misses_required_date && <span className="block"><Badge tone="red">After required date</Badge></span>}
                  </td>
                  <td className={td}>
                    {q.reliability.score === null ? (
                      <span className="text-xs text-slate-600">No score yet ({q.reliability.eligible_jobs} of {q.reliability.min_eligible_jobs ?? 5} jobs)</span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="font-semibold tabular-nums">{q.reliability.score.toFixed(1)}</span>
                        <ScoreLabelBadge label={q.reliability.label as "Excellent" | "Good" | "Average" | "Needs Improvement"} />
                        <span className="w-full text-xs text-slate-500">{q.reliability.basis === "category" ? "in this category" : "all categories"}</span>
                      </span>
                    )}
                  </td>
                  <td className={`${td} text-right font-semibold tabular-nums`}>{q.value_score === null ? "—" : q.value_score.toFixed(1)}</td>
                  <td className={td}>
                    {manage && (isOpen || r.status === "decided") && (
                      <span className="flex flex-col items-end gap-1">
                        {q.id !== r.selected_quotation_id && (
                          <Button variant="secondary" onClick={() => setChoose(q)}>
                            Choose
                          </Button>
                        )}
                        {isOpen && (
                          <span className="flex gap-1">
                            <Button variant="ghost" onClick={() => setEditQuote(q)} aria-label={`Edit quotation from ${q.vendor_name}`}>
                              Edit
                            </Button>
                            <Button variant="ghost" onClick={() => setWithdraw(q)} aria-label={`Withdraw quotation from ${q.vendor_name}`}>
                              Withdraw
                            </Button>
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {c.withdrawn.length > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            Withdrawn: {c.withdrawn.map((w) => `${w.vendor_name} (${formatDate(w.quote_date, dateFormat)}, ${w.withdrawn_reason})`).join("; ")}
          </p>
        )}
      </Card>

      {c.quotes.length > 0 && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card>
            <TotalCostChart quotes={c.quotes} recommendedId={c.recommendation.quotation_id} />
          </Card>
          <Card>
            <DeliveryChart quotes={c.quotes} />
          </Card>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Earlier jobs for this part (agreed job amount)">
          <PartJobs rows={c.history.part} dateFormat={dateFormat} empty="This part has not been given to a vendor before." />
        </Card>
        <Card title="Earlier quotations for this part">
          <PartQuotes rows={c.history.part_quotes} dateFormat={dateFormat} />
        </Card>
      </div>
      <Card className="mt-4" title={`Quoted vendors' recent jobs in ${r.category_name} (any part)`}>
        <PartJobs rows={c.history.category} dateFormat={dateFormat} showPart empty="The quoted vendors have no jobs in this category yet." />
      </Card>

      {dialog === "edit" && <RequestDialog request={r} open onClose={() => setDialog(null)} />}
      {dialog === "add" && <QuoteDialog cmp={c} open onClose={() => setDialog(null)} />}
      {editQuote && <QuoteDialog cmp={c} quote={editQuote} open onClose={() => setEditQuote(null)} />}
      {choose && <ChooseVendorDialog cmp={c} quote={choose} open onClose={() => setChoose(null)} />}
      {dialog === "job" && <CreateJobFromQuoteDialog cmp={c} open onClose={() => setDialog(null)} />}
      <ReasonDialog
        open={!!withdraw}
        title={`Withdraw the quotation from ${withdraw?.vendor_name ?? ""}?`}
        message="It stays in the history but is no longer compared. The vendor can then give a new quotation."
        confirmLabel="Withdraw"
        danger
        onCancel={() => setWithdraw(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("withdraw_quotation", { p_quotation_id: withdraw!.id, p_expected_version: withdraw!.version, p_reason: reason }));
          setWithdraw(null);
          await cmp.refetch();
        }}
      />
      <ReasonDialog
        open={dialog === "close"}
        title="Close this comparison without a job?"
        message="Use this when the requirement was dropped. It can be reopened later."
        confirmLabel="Close"
        danger
        onCancel={() => setDialog(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("close_quotation_request", { p_request_id: r.id, p_expected_version: r.version, p_reason: reason }));
          setDialog(null);
          await cmp.refetch();
        }}
      />
      <ReasonDialog
        open={dialog === "reopen"}
        title="Reopen this comparison?"
        message="The current choice is cleared (it stays in the Activity History) so quotations can be added or changed."
        confirmLabel="Reopen"
        onCancel={() => setDialog(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("reopen_quotation_request", { p_request_id: r.id, p_expected_version: r.version, p_reason: reason }));
          setDialog(null);
          await cmp.refetch();
        }}
      />
    </>
  );
}
