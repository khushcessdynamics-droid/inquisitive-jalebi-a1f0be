import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { todayIST } from "@cess/shared";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import type { AssignmentRow, JobRegisterRow, VendorRow } from "../lib/types";
import { useAssignableUsers, useCancelReasons, useCategories, useGivenBy, useVendors } from "../hooks/master";
import { useAuth } from "../auth/AuthProvider";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "./ui";

// ------------------------------------------------------------------ vendor assignment fields
export interface AssignmentDraft {
  vendor_id: string;
  dispatched_on: string;
  commitment_date: string;
  amount: string;
  qty_sent: string;
  remarks: string;
}

export function emptyAssignment(): AssignmentDraft {
  return { vendor_id: "", dispatched_on: todayIST(), commitment_date: "", amount: "", qty_sent: "", remarks: "" };
}

export function assignmentPayload(d: AssignmentDraft) {
  return {
    vendor_id: d.vendor_id,
    dispatched_on: d.dispatched_on,
    commitment_date: d.commitment_date || null,
    amount: d.amount.trim() ? d.amount.trim().replace(/,/g, "") : null,
    qty_sent: d.qty_sent.trim() ? Number(d.qty_sent) : null,
    remarks: d.remarks.trim(),
  };
}

export function assignmentProblem(d: AssignmentDraft): string | null {
  if (!d.vendor_id) return "Choose a vendor.";
  if (!d.dispatched_on) return "Enter the date given to the vendor.";
  if (d.dispatched_on > todayIST(new Date(Date.now() + 86_400_000))) return "Date given cannot be after tomorrow.";
  if (d.commitment_date && d.commitment_date < d.dispatched_on) return "The committed date cannot be before the date given.";
  if (d.amount.trim() && !/^\d+(\.\d{1,2})?$/.test(d.amount.trim().replace(/,/g, ""))) return "Amount must be a number in rupees (up to 2 decimals).";
  if (d.qty_sent.trim() && !/^[1-9]\d*$/.test(d.qty_sent.trim())) return "Quantity must be a whole number.";
  return null;
}

/** Active vendors; vendors that do the job's category are listed first. */
export function VendorSelect({ value, onChange, categoryId, exclude, id }: { value: string; onChange: (v: string) => void; categoryId?: string; exclude?: string; id?: string }) {
  const vendors = useVendors();
  const options = useMemo(() => {
    const active = (vendors.data ?? []).filter((v) => v.is_active && v.id !== exclude);
    const does = (v: VendorRow) => !!categoryId && (v.vendor_categories ?? []).some((c) => c.work_category_id === categoryId);
    return [...active.filter(does), ...active.filter((v) => !does(v))].map((v) => ({ v, match: does(v) }));
  }, [vendors.data, categoryId, exclude]);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{vendors.isLoading ? "Loading vendors..." : "Choose a vendor"}</option>
      {options.map(({ v, match }) => (
        <option key={v.id} value={v.id}>
          {v.name}
          {match ? " ✓ does this work" : ""}
        </option>
      ))}
    </Select>
  );
}

export function AssignmentFields({
  draft,
  onChange,
  categoryId,
  exclude,
  showQty = true,
  idPrefix = "as",
}: {
  draft: AssignmentDraft;
  onChange: (d: AssignmentDraft) => void;
  categoryId?: string;
  exclude?: string;
  showQty?: boolean;
  idPrefix?: string;
}) {
  const set = (k: keyof AssignmentDraft) => (v: string) => onChange({ ...draft, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Vendor" htmlFor={`${idPrefix}-vendor`}>
          <VendorSelect id={`${idPrefix}-vendor`} value={draft.vendor_id} onChange={set("vendor_id")} categoryId={categoryId} exclude={exclude} />
        </Field>
      </div>
      <Field label="Date given to vendor" htmlFor={`${idPrefix}-date`}>
        <Input id={`${idPrefix}-date`} type="date" value={draft.dispatched_on} onChange={(e) => set("dispatched_on")(e.target.value)} />
      </Field>
      <Field label="Vendor committed delivery date" htmlFor={`${idPrefix}-commit`} hint="Leave empty if the vendor has not committed yet.">
        <Input id={`${idPrefix}-commit`} type="date" min={draft.dispatched_on} value={draft.commitment_date} onChange={(e) => set("commitment_date")(e.target.value)} />
      </Field>
      <Field label="Estimated amount (₹)" htmlFor={`${idPrefix}-amount`}>
        <Input id={`${idPrefix}-amount`} inputMode="decimal" value={draft.amount} onChange={(e) => set("amount")(e.target.value)} placeholder="e.g. 12500" />
      </Field>
      {showQty && (
        <Field label="Quantity sent to this vendor" htmlFor={`${idPrefix}-qty`} hint="Empty = same as the job quantity.">
          <Input id={`${idPrefix}-qty`} inputMode="numeric" value={draft.qty_sent} onChange={(e) => set("qty_sent")(e.target.value)} />
        </Field>
      )}
      <div className="sm:col-span-2">
        <Field label="Remarks for this vendor (optional)" htmlFor={`${idPrefix}-remarks`}>
          <Input id={`${idPrefix}-remarks`} value={draft.remarks} maxLength={2000} onChange={(e) => set("remarks")(e.target.value)} />
        </Field>
      </div>
    </div>
  );
}

function useRefreshJob(jobId: string) {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["job", jobId] }),
      qc.invalidateQueries({ queryKey: ["job-assignments", jobId] }),
      qc.invalidateQueries({ queryKey: ["job-activity", jobId] }),
      qc.invalidateQueries({ queryKey: ["jobs"] }),
      qc.invalidateQueries({ queryKey: ["job-tab-counts"] }),
      qc.invalidateQueries({ queryKey: ["missing-data"] }),
    ]);
  };
}

// ------------------------------------------------------------------ dialogs
export function SendToVendorDialog({ job, open, onClose }: { job: JobRegisterRow; open: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<AssignmentDraft>(emptyAssignment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshJob(job.id);
  useEffect(() => {
    if (open) {
      setDraft(emptyAssignment());
      setError(null);
    }
  }, [open]);
  const problem = assignmentProblem(draft);
  return (
    <Modal
      open={open}
      title={`Send ${job.job_no} to a vendor`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!!problem}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                unwrap(await supabase.rpc("send_job_to_vendor", { p_job_id: job.id, p_expected_version: job.version, p: assignmentPayload(draft) }));
                await refresh();
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Send to vendor
          </Button>
        </>
      }
    >
      <AssignmentFields draft={draft} onChange={setDraft} categoryId={job.category_id} idPrefix="send" />
      {draft.vendor_id && problem && <Alert tone="warning">{problem}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

export function CancelForwardDialog({ job, assignment, vendorName, open, onClose }: { job: JobRegisterRow; assignment: AssignmentRow; vendorName: string; open: boolean; onClose: () => void }) {
  const reasons = useCancelReasons();
  const { can } = useAuth();
  const [cancelledOn, setCancelledOn] = useState(todayIST());
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const [forward, setForward] = useState(true);
  const [draft, setDraft] = useState<AssignmentDraft>(emptyAssignment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshJob(job.id);
  const canForward = can("assignments.change");
  useEffect(() => {
    if (open) {
      setCancelledOn(todayIST());
      setCode("");
      setText("");
      setForward(canForward);
      setDraft({ ...emptyAssignment(), amount: "", qty_sent: assignment.qty_sent ? String(assignment.qty_sent) : "" });
      setError(null);
    }
  }, [open, canForward, assignment.qty_sent]);
  const selected = reasons.data?.find((r) => r.code === code);
  const problem =
    !code ? "Choose the cancellation reason." : text.trim().length < 3 ? "Describe what happened (at least 3 characters)." : forward ? assignmentProblem(draft) : null;
  return (
    <Modal
      open={open}
      title={forward ? "Cancel vendor and forward the job" : "Cancel this vendor"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!!problem}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                unwrap(
                  await supabase.rpc("cancel_assignment", {
                    p_assignment_id: assignment.id,
                    p_expected_version: assignment.version,
                    p_cancelled_on: cancelledOn,
                    p_reason_code: code,
                    p_reason_text: text.trim(),
                    p_forward: forward ? assignmentPayload(draft) : null,
                  }),
                );
                await refresh();
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {forward ? "Cancel and forward" : "Cancel vendor"}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">
        The assignment with <strong>{vendorName}</strong> is kept in the job history with the reason below. It cannot be edited afterwards.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cancelled on" htmlFor="cx-date">
          <Input id="cx-date" type="date" min={assignment.dispatched_on} value={cancelledOn} onChange={(e) => setCancelledOn(e.target.value)} />
        </Field>
        <Field label="Reason" htmlFor="cx-reason" hint={selected ? (selected.vendor_related ? "Counts against this vendor's reliability score." : "Does not affect the vendor's score.") : undefined}>
          <Select id="cx-reason" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Choose a reason</option>
            <optgroup label="Caused by the vendor">
              {reasons.data?.filter((r) => r.is_active && r.vendor_related).map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Not the vendor's fault">
              {reasons.data?.filter((r) => r.is_active && !r.vendor_related).map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="What happened (saved with the cancellation)" htmlFor="cx-text">
            <Textarea id="cx-text" rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </div>
      </div>
      {canForward && (
        <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
          <input type="checkbox" checked={forward} onChange={(e) => setForward(e.target.checked)} /> Forward the same job to another vendor now
        </label>
      )}
      {forward && (
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <AssignmentFields draft={draft} onChange={setDraft} categoryId={job.category_id} exclude={assignment.vendor_id} idPrefix="fw" />
        </div>
      )}
      {problem && (code || text || draft.vendor_id) && <Alert tone="warning">{problem}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

export function EditJobDialog({ job, mode, open, onClose }: { job: JobRegisterRow; mode: "all" | "operational"; open: boolean; onClose: () => void }) {
  const categories = useCategories();
  const givenBy = useGivenBy();
  const users = useAssignableUsers(open && mode === "all");
  const [form, setForm] = useState({ part_label: "", description: "", qty_sent: "", category_id: "", given_by_id: "", assigned_staff_id: "", remarks: "" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshJob(job.id);
  useEffect(() => {
    if (open) {
      setForm({
        part_label: job.part_label,
        description: job.description,
        qty_sent: job.qty_sent ? String(job.qty_sent) : "",
        category_id: job.category_id,
        given_by_id: job.given_by_id ?? "",
        assigned_staff_id: job.assigned_staff_id ?? "",
        remarks: job.remarks,
      });
      setReason("");
      setError(null);
    }
  }, [open, job]);
  const qtyLocked = mode === "operational" && job.qty_sent !== null;
  const closed = !!job.closed_at;
  function changes(): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (form.description !== job.description) p.description = form.description;
    if (form.remarks !== job.remarks) p.remarks = form.remarks;
    if (!qtyLocked && !closed && form.qty_sent !== (job.qty_sent ? String(job.qty_sent) : "")) p.qty_sent = form.qty_sent ? Number(form.qty_sent) : null;
    if (mode === "all") {
      if (!closed && form.part_label.trim() !== job.part_label) p.part_label = form.part_label.trim();
      if (!closed && form.category_id !== job.category_id) p.category_id = form.category_id;
      if (form.given_by_id !== (job.given_by_id ?? "")) p.given_by_id = form.given_by_id || null;
      if (form.assigned_staff_id !== (job.assigned_staff_id ?? "")) p.assigned_staff_id = form.assigned_staff_id || null;
    }
    return p;
  }
  const p = changes();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal
      open={open}
      title={`Edit ${job.job_no}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={Object.keys(p).length === 0 || (mode === "all" && !form.part_label.trim()) || (!!form.qty_sent && !/^[1-9]\d*$/.test(form.qty_sent))}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                unwrap(await supabase.rpc("update_job", { p_job_id: job.id, p_expected_version: job.version, p, p_reason: reason.trim() || null }));
                await refresh();
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      {mode === "operational" && <Alert tone="info">Your role can change the description, remarks and an unknown quantity.</Alert>}
      {closed && <Alert tone="info">This job is completed: part, category and quantity can no longer change.</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Part No / Part Name" htmlFor="ej-part">
            <Input id="ej-part" value={form.part_label} maxLength={200} disabled={mode !== "all" || closed} onChange={set("part_label")} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor="ej-desc">
            <Textarea id="ej-desc" rows={2} maxLength={2000} value={form.description} onChange={set("description")} />
          </Field>
        </div>
        <Field label="Quantity sent" htmlFor="ej-qty" hint={qtyLocked ? "Recorded; only a Manager or Admin can change it." : undefined}>
          <Input id="ej-qty" inputMode="numeric" value={form.qty_sent} disabled={qtyLocked || closed} onChange={set("qty_sent")} />
        </Field>
        <Field label="Work category" htmlFor="ej-cat">
          <Select id="ej-cat" value={form.category_id} disabled={mode !== "all" || closed} onChange={set("category_id")}>
            {categories.data?.filter((c) => c.is_active || c.id === job.category_id).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Given By" htmlFor="ej-gb">
          <Select id="ej-gb" value={form.given_by_id} disabled={mode !== "all"} onChange={set("given_by_id")}>
            <option value="">—</option>
            {givenBy.data?.filter((g) => g.is_active || g.id === job.given_by_id).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned staff user" htmlFor="ej-staff">
          <Select id="ej-staff" value={form.assigned_staff_id} disabled={mode !== "all"} onChange={set("assigned_staff_id")}>
            <option value="">— nobody —</option>
            {mode === "all"
              ? users.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} ({u.role_label})
                  </option>
                ))
              : job.assigned_staff_id && <option value={job.assigned_staff_id}>{job.assigned_staff_name}</option>}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Remarks" htmlFor="ej-remarks">
            <Textarea id="ej-remarks" rows={2} maxLength={2000} value={form.remarks} onChange={set("remarks")} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Reason for the change (optional, saved in the history)" htmlFor="ej-reason">
            <Input id="ej-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

export function EditAssignmentDialog({ job, assignment, mode, open, onClose }: { job: JobRegisterRow; assignment: AssignmentRow; mode: "all" | "operational"; open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const [form, setForm] = useState({ vendor_id: "", dispatched_on: "", commitment_date: "", amount: "", qty_sent: "", remarks: "" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshJob(job.id);
  useEffect(() => {
    if (open) {
      setForm({
        vendor_id: assignment.vendor_id,
        dispatched_on: assignment.dispatched_on,
        commitment_date: assignment.original_commitment_date ?? "",
        amount: assignment.amount === null ? "" : String(assignment.amount),
        qty_sent: assignment.qty_sent ? String(assignment.qty_sent) : "",
        remarks: assignment.remarks,
      });
      setReason("");
      setError(null);
    }
  }, [open, assignment]);
  const canCorrect = can("assignments.change");
  const commitmentKnown = assignment.original_commitment_date !== null;
  const p: Record<string, unknown> = {};
  if (canCorrect && form.vendor_id !== assignment.vendor_id) p.vendor_id = form.vendor_id;
  if (canCorrect && form.dispatched_on !== assignment.dispatched_on) p.dispatched_on = form.dispatched_on;
  if (!commitmentKnown && form.commitment_date) p.commitment_date = form.commitment_date;
  if (mode === "all" && form.amount !== (assignment.amount === null ? "" : String(assignment.amount))) p.amount = form.amount.trim() ? form.amount.trim().replace(/,/g, "") : null;
  if ((mode === "all" || assignment.qty_sent === null) && form.qty_sent !== (assignment.qty_sent ? String(assignment.qty_sent) : "")) p.qty_sent = form.qty_sent ? Number(form.qty_sent) : null;
  if (form.remarks !== assignment.remarks) p.remarks = form.remarks;
  const needsReason = "vendor_id" in p || "dispatched_on" in p;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal
      open={open}
      title="Vendor details for this job"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={Object.keys(p).length === 0 || (needsReason && reason.trim().length < 3)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                unwrap(await supabase.rpc("update_assignment", { p_assignment_id: assignment.id, p_expected_version: assignment.version, p, p_reason: reason.trim() || null }));
                await refresh();
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Vendor" htmlFor="ea-vendor" hint={canCorrect ? "Correct a data-entry mistake only. To change vendor, use Cancel & forward." : undefined}>
            <VendorSelect id="ea-vendor" value={form.vendor_id} onChange={(v) => setForm({ ...form, vendor_id: v })} categoryId={job.category_id} />
          </Field>
        </div>
        <Field label="Date given to vendor" htmlFor="ea-date">
          <Input id="ea-date" type="date" disabled={!canCorrect} value={form.dispatched_on} onChange={set("dispatched_on")} />
        </Field>
        <Field
          label="Vendor committed delivery date"
          htmlFor="ea-commit"
          hint={commitmentKnown ? "Recorded and locked. Revisions are kept in the commitment history (next phase)." : "Can be entered once; it then becomes the original commitment."}
        >
          <Input id="ea-commit" type="date" min={form.dispatched_on} disabled={commitmentKnown} value={form.commitment_date} onChange={set("commitment_date")} />
        </Field>
        <Field label="Estimated amount (₹)" htmlFor="ea-amount">
          <Input id="ea-amount" inputMode="decimal" disabled={mode !== "all"} value={form.amount} onChange={set("amount")} />
        </Field>
        <Field label="Quantity sent to this vendor" htmlFor="ea-qty">
          <Input id="ea-qty" inputMode="numeric" disabled={mode !== "all" && assignment.qty_sent !== null} value={form.qty_sent} onChange={set("qty_sent")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Remarks" htmlFor="ea-remarks">
            <Input id="ea-remarks" maxLength={2000} value={form.remarks} onChange={set("remarks")} />
          </Field>
        </div>
        {needsReason && (
          <div className="sm:col-span-2">
            <Field label="Reason for correcting the vendor or date (required)" htmlFor="ea-reason">
              <Input id="ea-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        )}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

export function ReclassifyDialog({ assignmentId, version, jobId, open, onClose, onDone }: { assignmentId: string; version: number; jobId: string; open: boolean; onClose: () => void; onDone?: () => void }) {
  const reasons = useCancelReasons();
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshJob(jobId);
  useEffect(() => {
    if (open) {
      setCode("");
      setText("");
      setError(null);
    }
  }, [open]);
  return (
    <Modal
      open={open}
      title="Classify the cancellation"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!code || text.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                unwrap(await supabase.rpc("reclassify_cancellation", { p_assignment_id: assignmentId, p_expected_version: version, p_reason_code: code, p_reason_text: text.trim() }));
                await refresh();
                onDone?.();
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">The Excel tracker did not record why this vendor was cancelled. This can be set once and decides whether it counts against the vendor.</p>
      <Field label="Reason" htmlFor="rc-code">
        <Select id="rc-code" value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">Choose a reason</option>
          {reasons.data
            ?.filter((r) => r.is_active && r.code !== "legacy_unclassified")
            .map((r) => (
              <option key={r.code} value={r.code}>
                {r.vendor_related ? "Vendor: " : "Not vendor: "}
                {r.label}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="How do you know? (saved in the history)" htmlFor="rc-text">
        <Textarea id="rc-text" rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}
