import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, IndianRupee, PlusCircle } from "lucide-react";
import { formatDate, formatINR, todayIST, type DateFormat } from "@cess/shared";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import type { AssignmentRow } from "../lib/types";
import { useRealtimeInvalidate } from "../hooks/data";
import { Alert, Badge, Button, Field, Input, Modal, ReasonDialog, Select, Spinner, Textarea, cx } from "./ui";

export interface PaymentAccount {
  assignment_id: string;
  job_id: string;
  job_no: string;
  part_label: string;
  category_name: string;
  vendor_id: string;
  vendor_name: string;
  sequence_no: number;
  assignment_state: "open" | "completed" | "cancelled";
  dispatched_on: string;
  completed_on: string | null;
  cancelled_on: string | null;
  assignment_version: number;
  qty_sent: number | null;
  job_amount: number | null;
  invoice_no: string | null;
  invoice_date: string | null;
  additional_charges: number;
  discount: number;
  advance_paid: number;
  regular_paid: number;
  amount_paid: number;
  total_payable: number | null;
  balance: number | null;
  payment_status: PaymentStatus;
  last_paid_on: string | null;
  payment_count: number;
  financial_year: string;
  archived: boolean;
}

export type PaymentStatus = "Unpaid" | "Advance Paid" | "Partially Paid" | "Fully Paid";

export interface LedgerEntry {
  entry_type: "payment" | "adjustment";
  id: string;
  entry_no: string | null;
  assignment_id: string;
  job_id: string;
  job_no: string;
  part_label: string;
  vendor_id: string;
  vendor_name: string;
  kind: "advance" | "payment" | "additional_charge" | "discount";
  entry_date: string;
  amount: number;
  mode: string | null;
  reference: string;
  remarks: string;
  reversal_of: string | null;
  reversed: boolean;
  created_at: string;
  recorded_by_name: string | null;
}

export const PAYMENT_MODES: Record<string, string> = {
  bank_transfer: "Bank transfer (NEFT / RTGS / IMPS)",
  upi: "UPI",
  cheque: "Cheque",
  cash: "Cash",
  other: "Other",
};

export const KIND_LABEL: Record<LedgerEntry["kind"], string> = {
  advance: "Advance",
  payment: "Payment",
  additional_charge: "Additional charge",
  discount: "Discount",
};

const STATUS_TONE: Record<PaymentStatus, "slate" | "blue" | "amber" | "green"> = {
  Unpaid: "slate",
  "Advance Paid": "blue",
  "Partially Paid": "amber",
  "Fully Paid": "green",
};
export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

export function entryLabel(e: LedgerEntry): string {
  return `${e.reversal_of ? "Reversal: " : ""}${KIND_LABEL[e.kind]}`;
}

export function useJobPayments(jobId: string, enabled: boolean) {
  useRealtimeInvalidate(["vendor_payments", "payment_adjustments", "job_assignments"], ["job-payments", jobId]);
  return useQuery({
    queryKey: ["job-payments", jobId],
    enabled,
    queryFn: async () => {
      const [acc, led] = await Promise.all([
        supabase.from("payment_accounts").select("*").eq("job_id", jobId).order("sequence_no"),
        supabase.from("payment_ledger").select("*").eq("job_id", jobId).order("entry_date").order("created_at"),
      ]);
      return { accounts: unwrap(acc) as PaymentAccount[], ledger: unwrap(led) as LedgerEntry[] };
    },
  });
}

function useRefresh(jobId?: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      [["job-payments", jobId], ["payment-accounts"], ["payment-ledger"], ["payment-summary"], ["payment-periods"], ["job", jobId], ["job-assignments", jobId], ["job-activity", jobId]]
        .filter((k) => k[1] !== undefined || k.length === 1)
        .map((queryKey) => qc.invalidateQueries({ queryKey })),
    );
}

const money = (v: string) => v.replace(/,/g, "").trim();
const validMoney = (v: string) => /^\d+(\.\d{1,2})?$/.test(money(v)) && Number(money(v)) > 0;

// ------------------------------------------------------------------ dialogs
export function InvoiceDialog({ jobId, assignmentId, version, current, open, onClose }: { jobId: string; assignmentId: string; version: number; current: { amount: number | null; invoice_no: string | null; invoice_date: string | null; paid: number }; open: boolean; onClose: () => void }) {
  const refresh = useRefresh(jobId);
  const [form, setForm] = useState({ invoice_no: "", invoice_date: todayIST(), amount: "" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ invoice_no: current.invoice_no ?? "", invoice_date: current.invoice_date ?? todayIST(), amount: current.amount === null ? "" : String(current.amount) });
      setReason("");
      setError(null);
    }
  }, [open, current.amount, current.invoice_no, current.invoice_date]);
  const changing = current.amount !== null && validMoney(form.amount) && Number(money(form.amount)) !== Number(current.amount);
  const problem = !validMoney(form.amount) ? "Enter the invoice amount in rupees." : form.invoice_date > todayIST() ? "The invoice date cannot be in the future." : changing && reason.trim().length < 3 ? "Give the reason for changing the job amount." : null;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal
      open={open}
      title="Record vendor invoice"
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
                unwrap(
                  await supabase.rpc("record_vendor_invoice", {
                    p_assignment_id: assignmentId,
                    p_expected_version: version,
                    p: { invoice_no: form.invoice_no.trim() || null, invoice_date: form.invoice_date || null, amount: money(form.amount) },
                    p_reason: reason.trim() || null,
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
            Save invoice
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">The invoice amount becomes the job amount: total payable = job amount + additional charges − discounts.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Invoice number" htmlFor="inv-no">
          <Input id="inv-no" maxLength={100} value={form.invoice_no} onChange={set("invoice_no")} />
        </Field>
        <Field label="Invoice date" htmlFor="inv-date">
          <Input id="inv-date" type="date" max={todayIST()} value={form.invoice_date} onChange={set("invoice_date")} />
        </Field>
        <Field label="Invoice amount (₹)" htmlFor="inv-amount" hint={current.amount !== null ? `Job amount now ${formatINR(current.amount)}` : undefined}>
          <Input id="inv-amount" inputMode="decimal" value={form.amount} onChange={set("amount")} />
        </Field>
      </div>
      {changing && (
        <Field label="Reason for changing the job amount (required)" htmlFor="inv-reason">
          <Input id="inv-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

export function PaymentDialog({ jobId, account, assignmentId, open, onClose }: { jobId: string; account: PaymentAccount | null; assignmentId: string; open: boolean; onClose: () => void }) {
  const refresh = useRefresh(jobId);
  const balance = account?.balance ?? null;
  const [form, setForm] = useState({ kind: "payment" as "payment" | "advance", paid_on: todayIST(), amount: "", mode: "bank_transfer", reference: "", remarks: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      const kind = balance === null ? "advance" : "payment";
      setForm({ kind, paid_on: todayIST(), amount: balance !== null && balance > 0 ? String(balance) : "", mode: "bank_transfer", reference: "", remarks: "" });
      setError(null);
    }
  }, [open, balance]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const amt = validMoney(form.amount) ? Number(money(form.amount)) : null;
  const problem =
    amt === null
      ? "Enter the amount paid."
      : balance !== null && amt > balance
        ? `This is more than the balance of ${formatINR(balance)}.`
        : balance === null && form.kind === "payment"
          ? "Record the vendor invoice first, or record this as an advance."
          : !form.paid_on || form.paid_on > todayIST()
            ? "Payment date cannot be in the future."
            : null;
  return (
    <Modal
      open={open}
      title="Add payment"
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
                unwrap(await supabase.rpc("add_vendor_payment", { p_assignment_id: assignmentId, p: { ...form, amount: money(form.amount) } }));
                await refresh();
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save payment
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        {balance === null ? "No job amount recorded yet: only an advance can be recorded." : `Balance before this payment: ${formatINR(balance)}`}
      </p>
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Type</legend>
        <div className="mt-1 flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="pay-kind" checked={form.kind === "advance"} onChange={() => setForm({ ...form, kind: "advance" })} /> Advance
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="pay-kind" disabled={balance === null} checked={form.kind === "payment"} onChange={() => setForm({ ...form, kind: "payment" })} /> Payment
          </label>
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount paid (₹)" htmlFor="pay-amount" hint={balance !== null && amt !== null && amt <= balance ? `Balance after: ${formatINR(balance - amt)}` : undefined}>
          <Input id="pay-amount" inputMode="decimal" value={form.amount} onChange={set("amount")} />
        </Field>
        <Field label="Payment date" htmlFor="pay-date">
          <Input id="pay-date" type="date" max={todayIST()} value={form.paid_on} onChange={set("paid_on")} />
        </Field>
        <Field label="Payment mode" htmlFor="pay-mode">
          <Select id="pay-mode" value={form.mode} onChange={set("mode")}>
            {Object.entries(PAYMENT_MODES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Transaction reference (UTR / cheque no.)" htmlFor="pay-ref">
          <Input id="pay-ref" maxLength={100} value={form.reference} onChange={set("reference")} />
        </Field>
      </div>
      <Field label="Payment remarks" htmlFor="pay-rem">
        <Textarea id="pay-rem" rows={2} maxLength={1000} value={form.remarks} onChange={set("remarks")} />
      </Field>
      {amt !== null && problem && <Alert tone="warning">{problem}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

export function AdjustmentDialog({ jobId, assignmentId, open, onClose }: { jobId: string; assignmentId: string; open: boolean; onClose: () => void }) {
  const refresh = useRefresh(jobId);
  const [form, setForm] = useState({ kind: "additional_charge" as "additional_charge" | "discount", entry_date: todayIST(), amount: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm({ kind: "additional_charge", entry_date: todayIST(), amount: "", description: "" });
      setError(null);
    }
  }, [open]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const problem = !validMoney(form.amount) ? "Enter the amount." : form.description.trim().length < 3 ? "Describe the charge or discount." : null;
  return (
    <Modal
      open={open}
      title="Additional charge or discount"
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
                unwrap(await supabase.rpc("add_payment_adjustment", { p_assignment_id: assignmentId, p: { ...form, amount: money(form.amount) } }));
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
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Type</legend>
        <div className="mt-1 flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="adj-kind" checked={form.kind === "additional_charge"} onChange={() => setForm({ ...form, kind: "additional_charge" })} /> Additional charge (adds to payable)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="adj-kind" checked={form.kind === "discount"} onChange={() => setForm({ ...form, kind: "discount" })} /> Discount (reduces payable)
          </label>
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount (₹)" htmlFor="adj-amount">
          <Input id="adj-amount" inputMode="decimal" value={form.amount} onChange={set("amount")} />
        </Field>
        <Field label="Date" htmlFor="adj-date">
          <Input id="adj-date" type="date" max={todayIST()} value={form.entry_date} onChange={set("entry_date")} />
        </Field>
      </div>
      <Field label="Description" htmlFor="adj-desc" hint="e.g. Transport, extra operation, late-delivery discount">
        <Input id="adj-desc" maxLength={500} value={form.description} onChange={set("description")} />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

// ------------------------------------------------------------------ card on the job page
function Figure({ label, children, strong }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={cx("tabular-nums", strong ? "text-base font-semibold text-slate-900" : "text-sm text-slate-800")}>{children}</dd>
    </div>
  );
}

type AssignmentWithVendor = AssignmentRow & { vendor: { name: string } | null };

export function PaymentsCard({ jobId, assignments, dateFormat, archived }: { jobId: string; assignments: AssignmentWithVendor[]; dateFormat: DateFormat; archived: boolean }) {
  const { can } = useAuth();
  const data = useJobPayments(jobId, can("payments.view"));
  const refresh = useRefresh(jobId);
  const [dialog, setDialog] = useState<null | { kind: "invoice" | "payment" | "adjustment"; assignment: AssignmentWithVendor }>(null);
  const [reverse, setReverse] = useState<LedgerEntry | null>(null);
  if (!can("payments.view")) return null;
  if (data.isLoading) return <Spinner />;
  if (data.error) return <Alert tone="error">{toAppError(data.error).message}</Alert>;
  const { accounts, ledger } = data.data!;
  const shown = assignments.filter((a) => a.state !== "cancelled" || accounts.some((x) => x.assignment_id === a.id));
  const add = can("payments.add") && !archived;
  if (!shown.length) return <p className="text-sm text-slate-600">Not given to a vendor yet.</p>;
  return (
    <div className="space-y-5">
      {!add && <p className="text-xs text-slate-500">View only. Payments are recorded by an Admin.</p>}
      {shown.map((a) => {
        const acc = accounts.find((x) => x.assignment_id === a.id) ?? null;
        const entries = ledger.filter((e) => e.assignment_id === a.id);
        return (
          <div key={a.id} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">
                {a.sequence_no}. {a.vendor?.name} {acc && <PaymentStatusBadge status={acc.payment_status} />}
              </p>
              {add && (
                <span className="flex flex-wrap gap-1">
                  <Button variant="secondary" className="px-2.5 py-1" onClick={() => setDialog({ kind: "invoice", assignment: a })}>
                    <FileText className="h-4 w-4" /> {acc?.invoice_no || acc?.invoice_date ? "Change invoice" : "Record invoice"}
                  </Button>
                  <Button className="px-2.5 py-1" onClick={() => setDialog({ kind: "payment", assignment: a })}>
                    <IndianRupee className="h-4 w-4" /> Add payment
                  </Button>
                  <Button variant="ghost" className="px-2.5 py-1" onClick={() => setDialog({ kind: "adjustment", assignment: a })}>
                    <PlusCircle className="h-4 w-4" /> Charge / discount
                  </Button>
                </span>
              )}
            </div>
            {!acc ? (
              <p className="text-sm text-slate-600">No job amount and no payments recorded.</p>
            ) : (
              <dl className="grid grid-cols-2 gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-4">
                <Figure label="Job amount">
                  {acc.job_amount === null ? <span className="text-amber-700">not recorded</span> : formatINR(acc.job_amount)}
                  {(acc.invoice_no || acc.invoice_date) && (
                    <span className="block text-xs text-slate-500">
                      Invoice {acc.invoice_no ?? ""} {acc.invoice_date ? formatDate(acc.invoice_date, dateFormat) : ""}
                    </span>
                  )}
                </Figure>
                <Figure label="Additional charges">{formatINR(acc.additional_charges)}</Figure>
                <Figure label="Discount">{formatINR(acc.discount)}</Figure>
                <Figure label="Total payable" strong>
                  {acc.total_payable === null ? "—" : formatINR(acc.total_payable)}
                </Figure>
                <Figure label="Advance paid">{formatINR(acc.advance_paid)}</Figure>
                <Figure label="Amount paid (incl. advance)">{formatINR(acc.amount_paid)}</Figure>
                <Figure label="Balance" strong>
                  <span className={acc.balance && acc.balance > 0 ? "text-red-700" : undefined}>{acc.balance === null ? "—" : formatINR(acc.balance)}</span>
                </Figure>
                <Figure label="Last payment">{acc.last_paid_on ? formatDate(acc.last_paid_on, dateFormat) : "—"}</Figure>
              </dl>
            )}
            {entries.length > 0 && (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {entries.map((e) => (
                  <li key={e.id} className={cx("flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm", (e.reversed || e.reversal_of) && "text-slate-500")}>
                    <span>
                      <span className={e.reversed ? "line-through" : ""}>
                        {formatDate(e.entry_date, dateFormat)} · {entryLabel(e)}
                        {e.entry_no ? ` ${e.entry_no}` : ""} · <strong className="tabular-nums">{formatINR(e.kind === "discount" ? -e.amount : e.amount)}</strong>
                      </span>
                      {e.mode && <span className="text-slate-500"> · {PAYMENT_MODES[e.mode] ?? e.mode}</span>}
                      {e.reference && <span className="text-slate-500"> · {e.reference}</span>}
                      <span className="block text-xs text-slate-500">
                        {e.remarks && `${e.remarks} · `}by {e.recorded_by_name ?? "—"}
                        {e.reversed && " · reversed"}
                      </span>
                    </span>
                    {can("payments.manage") && !archived && !e.reversed && !e.reversal_of && (
                      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setReverse(e)} aria-label={`Reverse ${entryLabel(e)} ${e.entry_no ?? ""}`}>
                        Reverse
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {dialog?.kind === "invoice" && (
        <InvoiceDialog
          jobId={jobId}
          assignmentId={dialog.assignment.id}
          version={dialog.assignment.version}
          current={(() => {
            const acc = accounts.find((x) => x.assignment_id === dialog.assignment.id);
            return { amount: acc?.job_amount ?? dialog.assignment.amount, invoice_no: acc?.invoice_no ?? null, invoice_date: acc?.invoice_date ?? null, paid: acc?.amount_paid ?? 0 };
          })()}
          open
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "payment" && (
        <PaymentDialog jobId={jobId} assignmentId={dialog.assignment.id} account={accounts.find((x) => x.assignment_id === dialog.assignment.id) ?? null} open onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "adjustment" && <AdjustmentDialog jobId={jobId} assignmentId={dialog.assignment.id} open onClose={() => setDialog(null)} />}
      <ReasonDialog
        open={!!reverse}
        title={`Reverse ${reverse ? entryLabel(reverse).toLowerCase() : ""} ${reverse?.entry_no ?? ""}?`}
        message="The entry is not deleted: a reversal with your reason is added, and the balance is recalculated."
        confirmLabel="Add reversal"
        danger
        onCancel={() => setReverse(null)}
        onConfirm={async (reason) => {
          const fn = reverse!.entry_type === "payment" ? "reverse_vendor_payment" : "reverse_payment_adjustment";
          const arg = reverse!.entry_type === "payment" ? { p_payment_id: reverse!.id, p_reason: reason } : { p_adjustment_id: reverse!.id, p_reason: reason };
          unwrap(await supabase.rpc(fn, arg));
          setReverse(null);
          await refresh();
        }}
      />
    </div>
  );
}
