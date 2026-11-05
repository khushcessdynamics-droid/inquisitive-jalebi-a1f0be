import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, PackageCheck } from "lucide-react";
import { formatDate, formatDateTimeIST, todayIST, type DateFormat } from "@cess/shared";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import type { AssignmentRow } from "../lib/types";
import { useRealtimeInvalidate } from "../hooks/data";
import { Alert, Badge, Button, EmptyState, Field, Input, Modal, ReasonDialog, Spinner, cx } from "./ui";

export interface AssignmentQty {
  assignment_id: string;
  state: string;
  qty_sent: number | null;
  received: number;
  accepted: number;
  rejected: number;
  rework: number;
  inspected: number;
  awaiting: number;
  with_vendor: number | null;
  last_returned_on: string | null;
  returns: number;
  acceptance_pct: number | null;
  rejection_pct: number | null;
  rework_pct: number | null;
}

export interface ReturnLot {
  id: string;
  assignment_id: string;
  vendor_name: string;
  return_no: number;
  returned_on: string;
  qty_received: number;
  challan_no: string;
  remarks: string;
  created_at: string;
  recorded_by_name: string | null;
  voided_at: string | null;
  void_reason: string | null;
  voided_by_name: string | null;
  qty_accepted: number;
  qty_rejected: number;
  qty_rework: number;
  qty_uninspected: number;
  quality_status: string;
}

export interface InspectionRow {
  id: string;
  return_id: string;
  inspected_on: string;
  qty_accepted: number;
  qty_rejected: number;
  qty_rework: number;
  qty_inspected: number;
  quality_status: string;
  inspector_name: string;
  remarks: string;
  created_at: string;
  recorded_by_name: string | null;
  voided_at: string | null;
  void_reason: string | null;
}

const QUALITY_TONE: Record<string, "green" | "amber" | "red" | "blue" | "slate"> = {
  Accepted: "green",
  "Partially Accepted": "amber",
  "Rework Required": "amber",
  Rejected: "red",
  "Inspection Pending": "blue",
  Voided: "slate",
};
export function QualityBadge({ status }: { status: string }) {
  return <Badge tone={QUALITY_TONE[status] ?? "slate"}>{status}</Badge>;
}

export function useReturns(jobId: string) {
  useRealtimeInvalidate(["material_returns", "quality_inspections"], ["returns", jobId]);
  return useQuery({
    queryKey: ["returns", jobId],
    queryFn: async () => {
      const [qty, lots, insp] = await Promise.all([
        supabase.from("assignment_quantities").select("*").eq("job_id", jobId),
        supabase.from("material_return_lots").select("*").eq("job_id", jobId).order("return_no"),
        supabase.from("quality_inspection_log").select("*").eq("job_id", jobId).order("created_at"),
      ]);
      return {
        quantities: unwrap(qty) as AssignmentQty[],
        lots: unwrap(lots) as ReturnLot[],
        inspections: unwrap(insp) as InspectionRow[],
      };
    },
  });
}

function useRefresh(jobId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [["returns", jobId], ["job", jobId], ["job-assignments", jobId], ["job-activity", jobId], ["jobs"], ["job-tab-counts"], ["reliability"]].map((queryKey) =>
        qc.invalidateQueries({ queryKey }),
      ),
    );
}

function Num({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: string; hint?: string }) {
  return (
    <div className="rounded-md border border-slate-200 px-3 py-2">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cx("text-lg font-semibold tabular-nums", tone ?? "text-slate-900")}>{value}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function QuantityTiles({ q }: { q: AssignmentQty }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      <Num label="Sent" value={q.qty_sent ?? "?"} hint={q.qty_sent === null ? "quantity not recorded" : undefined} />
      <Num label="Returned" value={q.received} />
      <Num label="With vendor" value={q.with_vendor ?? "?"} tone={q.with_vendor ? "text-brand-700" : undefined} hint={q.rework ? `incl. ${q.rework} for rework` : undefined} />
      <Num label="Awaiting inspection" value={q.awaiting} tone={q.awaiting ? "text-amber-700" : undefined} />
      <Num label="Accepted" value={q.accepted} tone={q.accepted ? "text-emerald-700" : undefined} hint={q.acceptance_pct === null ? undefined : `${q.acceptance_pct.toFixed(1)}% of inspected`} />
      <Num label="Rejected" value={q.rejected} tone={q.rejected ? "text-red-700" : undefined} hint={q.rejection_pct === null ? undefined : `${q.rejection_pct.toFixed(1)}% of inspected`} />
      <Num label="Sent for rework" value={q.rework} hint={q.rework_pct === null || !q.rework ? undefined : `${q.rework_pct.toFixed(1)}% of inspected`} />
    </div>
  );
}

// ------------------------------------------------------------------ inspection fields (shared by both dialogs)
interface InspectionDraft {
  inspected_on: string;
  qty_accepted: string;
  qty_rejected: string;
  qty_rework: string;
  inspector_name: string;
  remarks: string;
}
function emptyInspection(name: string, date = todayIST()): InspectionDraft {
  return { inspected_on: date, qty_accepted: "", qty_rejected: "", qty_rework: "", inspector_name: name, remarks: "" };
}
const n0 = (v: string) => (v.trim() === "" ? 0 : Number(v));
const whole = (v: string) => v.trim() === "" || /^\d+$/.test(v.trim());
function inspectionProblem(d: InspectionDraft, max: number, minDate: string): string | null {
  if (![d.qty_accepted, d.qty_rejected, d.qty_rework].every(whole)) return "Quantities must be whole numbers.";
  const total = n0(d.qty_accepted) + n0(d.qty_rejected) + n0(d.qty_rework);
  if (total === 0) return "Enter the accepted, rejected or rework quantity.";
  if (total > max) return `Only ${max} pieces can be inspected here.`;
  if (!d.inspected_on || d.inspected_on < minDate || d.inspected_on > todayIST()) return "Inspection date must be between the return date and today.";
  if (!d.inspector_name.trim()) return "Enter who inspected.";
  return null;
}
function inspectionPayload(d: InspectionDraft) {
  return {
    inspected_on: d.inspected_on,
    qty_accepted: n0(d.qty_accepted),
    qty_rejected: n0(d.qty_rejected),
    qty_rework: n0(d.qty_rework),
    inspector_name: d.inspector_name.trim(),
    remarks: d.remarks.trim(),
  };
}

function InspectionFields({ d, onChange, max, prefix }: { d: InspectionDraft; onChange: (d: InspectionDraft) => void; max: number; prefix: string }) {
  const set = (k: keyof InspectionDraft) => (e: { target: { value: string } }) => onChange({ ...d, [k]: e.target.value });
  const total = n0(d.qty_accepted) + n0(d.qty_rejected) + n0(d.qty_rework);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Accepted" htmlFor={`${prefix}-acc`}>
        <Input id={`${prefix}-acc`} inputMode="numeric" value={d.qty_accepted} onChange={set("qty_accepted")} />
      </Field>
      <Field label="Rejected" htmlFor={`${prefix}-rej`}>
        <Input id={`${prefix}-rej`} inputMode="numeric" value={d.qty_rejected} onChange={set("qty_rejected")} />
      </Field>
      <Field label="Rework (back to vendor)" htmlFor={`${prefix}-rwk`}>
        <Input id={`${prefix}-rwk`} inputMode="numeric" value={d.qty_rework} onChange={set("qty_rework")} />
      </Field>
      <div className="sm:col-span-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span>
          {total} of {max} pieces inspected{total < max ? `; ${max - total} stay awaiting inspection` : ""}.
        </span>
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onChange({ ...d, qty_accepted: String(max), qty_rejected: "", qty_rework: "" })}>
          All {max} accepted
        </Button>
      </div>
      <Field label="Inspection date" htmlFor={`${prefix}-date`}>
        <Input id={`${prefix}-date`} type="date" max={todayIST()} value={d.inspected_on} onChange={set("inspected_on")} />
      </Field>
      <Field label="Inspected by" htmlFor={`${prefix}-by`}>
        <Input id={`${prefix}-by`} maxLength={120} value={d.inspector_name} onChange={set("inspector_name")} />
      </Field>
      <Field label="Inspection remarks" htmlFor={`${prefix}-rem`}>
        <Input id={`${prefix}-rem`} maxLength={2000} value={d.remarks} onChange={set("remarks")} />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------ record a return
export function RecordReturnDialog({ jobId, assignment, q, vendorName, open, onClose }: { jobId: string; assignment: AssignmentRow; q: AssignmentQty | undefined; vendorName: string; open: boolean; onClose: () => void }) {
  const { access, can } = useAuth();
  const refresh = useRefresh(jobId);
  const myName = access?.full_name || access?.email || "";
  const [form, setForm] = useState({ returned_on: todayIST(), qty_received: "", challan_no: "", remarks: "" });
  const [inspectNow, setInspectNow] = useState(false);
  const [insp, setInsp] = useState<InspectionDraft>(emptyInspection(myName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // reset only when the dialog opens (the quantities refresh after saving and must not wipe the result message)
  useEffect(() => {
    if (open) {
      setForm({ returned_on: todayIST(), qty_received: q?.with_vendor ? String(q.with_vendor) : "", challan_no: "", remarks: "" });
      setInspectNow(false);
      setInsp(emptyInspection(myName));
      setError(null);
      setDone(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const qty = /^\d+$/.test(form.qty_received.trim()) ? Number(form.qty_received) : 0;
  const withVendor = q?.with_vendor ?? null;
  const problem =
    qty < 1
      ? "Enter the quantity received (whole number)."
      : withVendor !== null && qty > withVendor
        ? `Only ${withVendor} pieces are with the vendor.`
        : !form.returned_on || form.returned_on < assignment.dispatched_on || form.returned_on > todayIST()
          ? "Return date must be between the date given to the vendor and today."
          : inspectNow
            ? inspectionProblem(insp, qty, form.returned_on)
            : null;
  return (
    <Modal
      open={open}
      title={`Record material return · ${vendorName}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && (
            <Button
              loading={busy}
              disabled={!!problem}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = unwrap(
                    await supabase.rpc("record_return", {
                      p_assignment_id: assignment.id,
                      p: { ...form, qty_received: qty, inspection: inspectNow ? inspectionPayload(insp) : null },
                    }),
                  ) as { completed: boolean };
                  await refresh();
                  if (res.completed) setDone("Every piece is back and inspected: the job is now Completed.");
                  else onClose();
                } catch (e) {
                  setError(toAppError(e).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save return
            </Button>
          )}
        </>
      }
    >
      {done ? (
        <Alert tone="success">{done}</Alert>
      ) : (
        <>
          {q && (
            <p className="text-sm text-slate-600">
              Sent {q.qty_sent ?? "?"} · returned so far {q.received} · <strong>with the vendor {withVendor ?? "unknown"}</strong>
              {q.rework ? ` (incl. ${q.rework} sent back for rework)` : ""}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Return date" htmlFor="rr-date">
              <Input id="rr-date" type="date" min={assignment.dispatched_on} max={todayIST()} value={form.returned_on} onChange={set("returned_on")} />
            </Field>
            <Field label="Quantity received" htmlFor="rr-qty" hint={withVendor !== null && qty > 0 && qty <= withVendor ? `${withVendor - qty} will still be with the vendor` : undefined}>
              <Input id="rr-qty" inputMode="numeric" value={form.qty_received} onChange={set("qty_received")} />
            </Field>
            <Field label="Delivery challan number (optional)" htmlFor="rr-dc">
              <Input id="rr-dc" maxLength={100} value={form.challan_no} onChange={set("challan_no")} />
            </Field>
            <Field label="Remarks" htmlFor="rr-rem">
              <Input id="rr-rem" maxLength={2000} value={form.remarks} onChange={set("remarks")} />
            </Field>
          </div>
          {can("quality.manage") && (
            <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <input type="checkbox" checked={inspectNow} onChange={(e) => setInspectNow(e.target.checked)} /> Record the quality inspection now
            </label>
          )}
          {inspectNow && qty > 0 && <InspectionFields d={insp} onChange={setInsp} max={qty} prefix="rr-i" />}
          {!inspectNow && <p className="text-xs text-slate-500">The pieces will show as awaiting inspection. The job is completed only after every piece is back and inspected.</p>}
          {qty > 0 && problem && <Alert tone="warning">{problem}</Alert>}
          {error && <Alert tone="error">{error}</Alert>}
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ inspect a return lot
export function InspectDialog({ jobId, lot, open, onClose }: { jobId: string; lot: ReturnLot; open: boolean; onClose: () => void }) {
  const { access } = useAuth();
  const refresh = useRefresh(jobId);
  const myName = access?.full_name || access?.email || "";
  const [d, setD] = useState<InspectionDraft>(emptyInspection(myName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setD(emptyInspection(myName));
      setError(null);
      setDone(null);
    }
  }, [open, myName]);
  const problem = inspectionProblem(d, lot.qty_uninspected, lot.returned_on);
  return (
    <Modal
      open={open}
      title={`Quality inspection · return ${lot.return_no} (${lot.qty_received} pcs, ${formatDate(lot.returned_on)})`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && (
            <Button
              loading={busy}
              disabled={!!problem}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = unwrap(await supabase.rpc("record_inspection", { p_return_id: lot.id, p: inspectionPayload(d) })) as { completed: boolean };
                  await refresh();
                  if (res.completed) setDone("Every piece is back and inspected: the job is now Completed.");
                  else onClose();
                } catch (e) {
                  setError(toAppError(e).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save inspection
            </Button>
          )}
        </>
      }
    >
      {done ? (
        <Alert tone="success">{done}</Alert>
      ) : (
        <>
          <p className="text-sm text-slate-600">{lot.qty_uninspected} pieces of this return are still to be inspected. Rework pieces go back to the vendor and are expected in a later return.</p>
          <InspectionFields d={d} onChange={setD} max={lot.qty_uninspected} prefix="in" />
          {problem && (d.qty_accepted || d.qty_rejected || d.qty_rework) && <Alert tone="warning">{problem}</Alert>}
          {error && <Alert tone="error">{error}</Alert>}
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ card on the job page
type AssignmentWithVendor = AssignmentRow & { vendor: { name: string } | null };

export function ReturnsCard({ jobId, assignments, jobClosed, dateFormat }: { jobId: string; assignments: AssignmentWithVendor[]; jobClosed: boolean; dateFormat: DateFormat }) {
  const { can } = useAuth();
  const data = useReturns(jobId);
  const refresh = useRefresh(jobId);
  // remembered when the dialog opens: after the last return the assignment is no longer "open" (completed)
  const [recordFor, setRecordFor] = useState<AssignmentWithVendor | null>(null);
  const [inspecting, setInspecting] = useState<ReturnLot | null>(null);
  const [voidLot, setVoidLot] = useState<ReturnLot | null>(null);
  const [voidInsp, setVoidInsp] = useState<InspectionRow | null>(null);
  const open = assignments.find((a) => a.state === "open") ?? null;
  const editable = (assignmentId: string) => !jobClosed && open?.id === assignmentId;

  if (data.isLoading) return <Spinner />;
  if (data.error) return <Alert tone="error">{toAppError(data.error).message}</Alert>;
  const { quantities, lots, inspections } = data.data!;
  const shown = assignments.filter((a) => a.state === "open" || lots.some((l) => l.assignment_id === a.id) || (a.state === "completed" && quantities.find((q) => q.assignment_id === a.id)));

  return (
    <div className="space-y-4">
      {open && !jobClosed && can("returns.record") && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setRecordFor(open)}>
            <PackageCheck className="h-4 w-4" /> Record return
          </Button>
        </div>
      )}
      {!shown.length && <EmptyState title="Not given to a vendor yet" />}
      {shown.map((a) => {
        const q = quantities.find((x) => x.assignment_id === a.id);
        const aLots = lots.filter((l) => l.assignment_id === a.id);
        return (
          <div key={a.id} className="space-y-2">
            <p className="text-sm font-semibold text-slate-900">
              {a.sequence_no}. {a.vendor?.name} {a.state === "cancelled" && <Badge>Cancelled</Badge>} {a.state === "completed" && <Badge tone="green">Completed</Badge>}
            </p>
            {q && (q.received > 0 || a.state === "open") && <QuantityTiles q={q} />}
            {!aLots.length ? (
              <p className="text-sm text-slate-600">{a.state === "completed" ? "Completed before returns were recorded in this system (e.g. imported from Excel)." : "Nothing returned yet."}</p>
            ) : (
              <ol className="space-y-2">
                {aLots.map((l) => {
                  const lotInsp = inspections.filter((i) => i.return_id === l.id);
                  return (
                    <li key={l.id} className={cx("rounded-md border px-3 py-2", l.voided_at ? "border-dashed border-slate-300 bg-slate-50 text-slate-500" : "border-slate-200")}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm">
                          <strong className={l.voided_at ? "line-through" : ""}>
                            Return {l.return_no} · {formatDate(l.returned_on, dateFormat)} · {l.qty_received} pcs
                          </strong>
                          {l.challan_no && <span className="text-slate-500"> · challan {l.challan_no}</span>} <QualityBadge status={l.quality_status} />
                        </p>
                        {editable(a.id) && !l.voided_at && (
                          <span className="flex gap-1">
                            {l.qty_uninspected > 0 && can("quality.manage") && (
                              <Button variant="secondary" className="px-2.5 py-1" onClick={() => setInspecting(l)}>
                                <ClipboardCheck className="h-4 w-4" /> Inspect {l.qty_uninspected}
                              </Button>
                            )}
                            {can("returns.record") && !lotInsp.some((i) => !i.voided_at) && (
                              <Button variant="ghost" className="px-2.5 py-1" onClick={() => setVoidLot(l)} aria-label={`Void return ${l.return_no}`}>
                                Void
                              </Button>
                            )}
                          </span>
                        )}
                      </div>
                      {!l.voided_at && (
                        <p className="mt-0.5 text-xs text-slate-600">
                          Accepted {l.qty_accepted} · Rejected {l.qty_rejected} · Rework {l.qty_rework}
                          {l.qty_uninspected > 0 && <span className="font-medium text-amber-700"> · {l.qty_uninspected} awaiting inspection</span>}
                        </p>
                      )}
                      <p className="text-xs text-slate-500">
                        Recorded by {l.recorded_by_name ?? "—"} · {formatDateTimeIST(l.created_at, dateFormat)}
                        {l.remarks && ` · ${l.remarks}`}
                      </p>
                      {l.voided_at && <p className="text-xs">Voided by {l.voided_by_name}: {l.void_reason}</p>}
                      {lotInsp.length > 0 && (
                        <ul className="mt-1 space-y-1 border-l-2 border-slate-200 pl-3">
                          {lotInsp.map((i) => (
                            <li key={i.id} className={cx("text-xs", i.voided_at ? "text-slate-400" : "text-slate-700")}>
                              <span className={i.voided_at ? "line-through" : ""}>
                                Inspected {formatDate(i.inspected_on, dateFormat)} by {i.inspector_name}: {i.qty_accepted} accepted, {i.qty_rejected} rejected, {i.qty_rework} rework
                              </span>{" "}
                              {!i.voided_at && <QualityBadge status={i.quality_status} />}
                              {i.remarks && <span className="text-slate-500"> · {i.remarks}</span>}
                              {i.voided_at && <span> · voided: {i.void_reason}</span>}
                              {editable(a.id) && !i.voided_at && can("quality.manage") && (
                                <button type="button" className="ml-2 text-xs font-medium text-slate-500 underline hover:text-slate-800" onClick={() => setVoidInsp(i)}>
                                  void
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        );
      })}
      {recordFor && (
        <RecordReturnDialog
          jobId={jobId}
          assignment={recordFor}
          q={quantities.find((q) => q.assignment_id === recordFor.id)}
          vendorName={recordFor.vendor?.name ?? ""}
          open
          onClose={() => setRecordFor(null)}
        />
      )}
      {inspecting && <InspectDialog jobId={jobId} lot={inspecting} open onClose={() => setInspecting(null)} />}
      <ReasonDialog
        open={!!voidLot}
        title={`Void return ${voidLot?.return_no ?? ""}?`}
        message="Use this for an entry made by mistake. It stays visible, crossed out, with your reason."
        confirmLabel="Void return"
        danger
        onCancel={() => setVoidLot(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("void_return", { p_return_id: voidLot!.id, p_reason: reason }));
          setVoidLot(null);
          await refresh();
        }}
      />
      <ReasonDialog
        open={!!voidInsp}
        title="Void this inspection?"
        message="The pieces go back to 'awaiting inspection'. The entry stays visible, crossed out, with your reason."
        confirmLabel="Void inspection"
        danger
        onCancel={() => setVoidInsp(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("void_inspection", { p_inspection_id: voidInsp!.id, p_reason: reason }));
          setVoidInsp(null);
          await refresh();
        }}
      />
    </div>
  );
}
