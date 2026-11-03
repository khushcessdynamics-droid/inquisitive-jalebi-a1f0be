import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { formatDate, formatINR, todayIST } from "@cess/shared";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import type { ComparedQuote, QuotationComparison, QuotationRequestRow } from "../lib/phase5Types";
import { useRealtimeInvalidate } from "../hooks/data";
import { useAssignableUsers, useCategories, useGivenBy } from "../hooks/master";
import { VendorSelect } from "./jobForms";
import { Alert, Button, Field, Input, Modal, Select, Textarea } from "./ui";

export const QUOTE_STATUS: Record<QuotationRequestRow["status"], { label: string; tone: "blue" | "amber" | "green" | "slate" }> = {
  open: { label: "Collecting quotations", tone: "blue" },
  decided: { label: "Vendor chosen", tone: "amber" },
  job_created: { label: "Job created", tone: "green" },
  closed: { label: "Closed", tone: "slate" },
};

export function useComparison(id: string) {
  useRealtimeInvalidate(["quotation_requests", "vendor_quotations"], ["quotation", id]);
  return useQuery({
    queryKey: ["quotation", id],
    queryFn: async () => unwrap(await supabase.rpc("quotation_comparison", { p_request_id: id })) as QuotationComparison,
  });
}

function useRefreshQuotes(id?: string) {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["quotation-list"] }), id ? qc.invalidateQueries({ queryKey: ["quotation", id] }) : Promise.resolve()]);
  };
}

// ------------------------------------------------------------------ request (requirement) dialog
export function RequestDialog({ request, open, onClose }: { request?: QuotationRequestRow; open: boolean; onClose: () => void }) {
  const categories = useCategories();
  const navigate = useNavigate();
  const refresh = useRefreshQuotes(request?.id);
  const [form, setForm] = useState({ part_label: "", category_id: "", qty: "", required_by: "", remarks: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const partQuery = form.part_label.trim();
  const parts = useQuery({
    queryKey: ["part-search", partQuery],
    enabled: open && partQuery.length >= 2,
    queryFn: async () => unwrap(await supabase.rpc("search_part_labels", { p_query: partQuery, p_limit: 8 })) as Array<{ part_label: string; jobs: number }>,
  });
  useEffect(() => {
    if (open) {
      setForm(
        request
          ? { part_label: request.part_label, category_id: request.category_id, qty: String(request.qty), required_by: request.required_by ?? "", remarks: request.remarks }
          : { part_label: "", category_id: "", qty: "", required_by: "", remarks: "" },
      );
      setError(null);
    }
  }, [open, request]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const problem = !form.part_label.trim()
    ? "Enter the Part No / Part Name."
    : !form.category_id
      ? "Choose the machining category."
      : !/^\d+$/.test(form.qty) || Number(form.qty) < 1
        ? "Enter the required quantity (whole number)."
        : null;
  return (
    <Modal
      open={open}
      title={request ? `Edit ${request.request_no}` : "New cost comparison"}
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
                const saved = unwrap(
                  await supabase.rpc("save_quotation_request", {
                    p_request_id: request?.id ?? null,
                    p_expected_version: request?.version ?? null,
                    p: { part_label: form.part_label.trim(), category_id: form.category_id, qty: Number(form.qty), required_by: form.required_by || null, remarks: form.remarks },
                  }),
                ) as QuotationRequestRow;
                await refresh();
                onClose();
                if (!request) navigate(`/quotes/${saved.id}`);
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {request ? "Save" : "Create and add quotations"}
          </Button>
        </>
      }
    >
      <Field label="Part No / Part Name" htmlFor="qr-part" hint="The same single field as on jobs, e.g. 4711 / Drive Shaft">
        <Input id="qr-part" list="qr-part-list" autoComplete="off" maxLength={200} value={form.part_label} onChange={set("part_label")} />
        <datalist id="qr-part-list">
          {parts.data?.map((p) => (
            <option key={p.part_label} value={p.part_label} />
          ))}
        </datalist>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Machining category" htmlFor="qr-cat">
          <Select id="qr-cat" value={form.category_id} onChange={set("category_id")}>
            <option value="">Choose...</option>
            {(categories.data ?? [])
              .filter((c) => c.is_active || c.id === form.category_id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Required quantity (pieces)" htmlFor="qr-qty" hint="Totals are calculated for this quantity">
          <Input id="qr-qty" inputMode="numeric" value={form.qty} onChange={set("qty")} />
        </Field>
        <Field label="Required by (optional)" htmlFor="qr-req">
          <Input id="qr-req" type="date" value={form.required_by} onChange={set("required_by")} />
        </Field>
      </div>
      <Field label="Remarks" htmlFor="qr-remarks">
        <Textarea id="qr-remarks" rows={2} maxLength={2000} value={form.remarks} onChange={set("remarks")} />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

// ------------------------------------------------------------------ quotation dialog
export function QuoteDialog({ cmp, quote, open, onClose }: { cmp: QuotationComparison; quote?: ComparedQuote; open: boolean; onClose: () => void }) {
  const r = cmp.request;
  const refresh = useRefreshQuotes(r.id);
  const [form, setForm] = useState({ vendor_id: "", quote_date: todayIST(), basis: "per_part" as "per_part" | "total", price: "", delivery_days: "", quote_ref: "", remarks: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setForm(
        quote
          ? { vendor_id: quote.vendor_id, quote_date: quote.quote_date, basis: quote.basis, price: String(quote.price), delivery_days: quote.delivery_days === null ? "" : String(quote.delivery_days), quote_ref: quote.quote_ref, remarks: quote.remarks }
          : { vendor_id: "", quote_date: todayIST(), basis: "per_part", price: "", delivery_days: "", quote_ref: "", remarks: "" },
      );
      setError(null);
    }
  }, [open, quote]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const cleaned = form.price.replace(/,/g, "").trim();
  const price = Number(cleaned);
  const priceOk = /^\d+(\.\d{1,2})?$/.test(cleaned) && price > 0;
  const total = priceOk ? (form.basis === "per_part" ? Math.round(price * r.qty * 100) / 100 : price) : null;
  const perPart = priceOk ? (form.basis === "per_part" ? price : Math.round((price / r.qty) * 100) / 100) : null;
  const taken = new Set(cmp.quotes.filter((q) => q.id !== quote?.id).map((q) => q.vendor_id));
  const problem = !form.vendor_id
    ? "Choose the vendor."
    : taken.has(form.vendor_id)
      ? "This vendor already has a quotation here. Edit that one instead."
      : !form.quote_date
        ? "Enter the quotation date."
        : !priceOk
          ? "Enter the quoted price in rupees (up to 2 decimals)."
          : form.delivery_days !== "" && (!/^\d+$/.test(form.delivery_days) || Number(form.delivery_days) > 365)
            ? "Expected delivery days must be a whole number from 0 to 365."
            : null;
  return (
    <Modal
      open={open}
      title={quote ? `Edit quotation · ${quote.vendor_name}` : `Add a quotation · ${r.request_no}`}
      onClose={onClose}
      wide
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
                  await supabase.rpc("save_quotation", {
                    p_quotation_id: quote?.id ?? null,
                    p_expected_version: quote?.version ?? null,
                    p_request_id: r.id,
                    p: {
                      vendor_id: form.vendor_id,
                      quote_date: form.quote_date,
                      basis: form.basis,
                      price: form.price.replace(/,/g, "").trim(),
                      delivery_days: form.delivery_days === "" ? null : Number(form.delivery_days),
                      quote_ref: form.quote_ref,
                      remarks: form.remarks,
                    },
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
            Save quotation
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        {r.part_label} · {r.category_name} · <strong>{r.qty} pcs</strong>
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Vendor" htmlFor="q-vendor">
            <VendorSelect id="q-vendor" value={form.vendor_id} onChange={(v) => setForm({ ...form, vendor_id: v })} categoryId={r.category_id} />
          </Field>
        </div>
        <Field label="Quotation date" htmlFor="q-date">
          <Input id="q-date" type="date" value={form.quote_date} onChange={set("quote_date")} />
        </Field>
        <Field label="Quotation reference (optional)" htmlFor="q-ref">
          <Input id="q-ref" maxLength={100} value={form.quote_ref} onChange={set("quote_ref")} />
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-slate-700">The vendor quoted</legend>
          <div className="mt-1 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="q-basis" checked={form.basis === "per_part"} onChange={() => setForm({ ...form, basis: "per_part" })} /> a rate per part
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="q-basis" checked={form.basis === "total"} onChange={() => setForm({ ...form, basis: "total" })} /> one amount for all {r.qty} pcs
            </label>
          </div>
        </fieldset>
        <Field label={form.basis === "per_part" ? "Per-part rate (₹)" : `Quoted amount for ${r.qty} pcs (₹)`} htmlFor="q-price" hint="Enter every quotation the same way (all with GST or all without)">
          <Input id="q-price" inputMode="decimal" value={form.price} onChange={set("price")} />
        </Field>
        <Field label="Expected delivery days" htmlFor="q-days" hint="Leave empty if the vendor did not say">
          <Input id="q-days" inputMode="numeric" value={form.delivery_days} onChange={set("delivery_days")} />
        </Field>
        <div className="sm:col-span-2 rounded-md bg-slate-50 px-3 py-2 text-sm" aria-live="polite">
          {total === null ? (
            <span className="text-slate-500">Total and per-part rate are calculated from the price.</span>
          ) : (
            <>
              Per part <strong>{formatINR(perPart)}</strong> · Total for {r.qty} pcs <strong>{formatINR(total)}</strong>
            </>
          )}
        </div>
        <div className="sm:col-span-2">
          <Field label="Remarks" htmlFor="q-remarks">
            <Textarea id="q-remarks" rows={2} maxLength={2000} value={form.remarks} onChange={set("remarks")} />
          </Field>
        </div>
      </div>
      {form.vendor_id && problem && <Alert tone="warning">{problem}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

// ------------------------------------------------------------------ choose vendor
export function ChooseVendorDialog({ cmp, quote, open, onClose }: { cmp: QuotationComparison; quote: ComparedQuote; open: boolean; onClose: () => void }) {
  const refresh = useRefreshQuotes(cmp.request.id);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);
  const rec = cmp.quotes.find((q) => q.id === cmp.recommendation.quotation_id) ?? null;
  const differs = rec !== null && rec.id !== quote.id;
  return (
    <Modal
      open={open}
      title={`Choose ${quote.vendor_name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={differs && reason.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                unwrap(await supabase.rpc("select_quotation", { p_request_id: cmp.request.id, p_expected_version: cmp.request.version, p_quotation_id: quote.id, p_reason: reason.trim() || null }));
                await refresh();
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Choose this vendor
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700">
        {quote.vendor_name}: {formatINR(quote.total)} for {cmp.request.qty} pcs ({formatINR(quote.per_part)} per part)
        {quote.delivery_days !== null ? `, ${quote.delivery_days} days` : ""}.
      </p>
      <p className="text-sm text-slate-600">This only records your choice. No job is created and nothing is sent to the vendor until you confirm "Create job" in the next step.</p>
      {differs && (
        <Alert tone="warning" title={`The recommendation was ${rec.vendor_name}`}>
          Please note why you prefer {quote.vendor_name}; the reason is kept with the decision.
        </Alert>
      )}
      <Field label={differs ? "Reason for choosing this vendor (required)" : "Note (optional)"} htmlFor="cv-reason">
        <Textarea id="cv-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

// ------------------------------------------------------------------ create job from the decision
export function CreateJobFromQuoteDialog({ cmp, open, onClose }: { cmp: QuotationComparison; open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const refresh = useRefreshQuotes(cmp.request.id);
  const givenBy = useGivenBy();
  const users = useAssignableUsers(open);
  const quote = cmp.quotes.find((q) => q.id === cmp.request.selected_quotation_id);
  const [form, setForm] = useState({ dispatched_on: todayIST(), commitment_date: "", given_by_id: "", assigned_staff_id: "", description: "", remarks: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      const today = todayIST();
      let commit = "";
      if (quote?.delivery_days !== null && quote?.delivery_days !== undefined) {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + quote.delivery_days);
        commit = d.toISOString().slice(0, 10);
      }
      setForm({ dispatched_on: today, commitment_date: commit, given_by_id: "", assigned_staff_id: "", description: "", remarks: "" });
      setError(null);
    }
  }, [open, quote]);
  if (!quote) return null;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const problem = !form.dispatched_on
    ? "Enter the date given to the vendor."
    : form.commitment_date && form.commitment_date < form.dispatched_on
      ? "The committed date cannot be before the date given."
      : null;
  return (
    <Modal
      open={open}
      title="Create the job for the chosen vendor"
      onClose={onClose}
      wide
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
                const res = unwrap(
                  await supabase.rpc("create_job_from_quotation", {
                    p_request_id: cmp.request.id,
                    p_expected_version: cmp.request.version,
                    p: {
                      dispatched_on: form.dispatched_on,
                      commitment_date: form.commitment_date || null,
                      given_by_id: form.given_by_id || null,
                      assigned_staff_id: form.assigned_staff_id || null,
                      description: form.description,
                      remarks: form.remarks,
                    },
                  }),
                ) as { id: string; job_no: string };
                await refresh();
                onClose();
                navigate(`/jobs/${res.id}`, { state: { created: res.job_no } });
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create job and give to {quote.vendor_name}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 rounded-md bg-slate-50 p-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-slate-500">Part</p>
          <p className="font-medium">{cmp.request.part_label}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Quantity</p>
          <p className="font-medium">{cmp.request.qty} pcs</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Vendor</p>
          <p className="font-medium">{quote.vendor_name}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Job amount (quoted total)</p>
          <p className="font-medium">{formatINR(quote.total)}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Date given to vendor" htmlFor="cj-date">
          <Input id="cj-date" type="date" value={form.dispatched_on} onChange={set("dispatched_on")} />
        </Field>
        <Field
          label="Vendor committed delivery date"
          htmlFor="cj-commit"
          hint={quote.delivery_days !== null ? `Suggested from the quotation (${quote.delivery_days} days). Confirm with the vendor.` : "Leave empty if not confirmed yet."}
        >
          <Input id="cj-commit" type="date" min={form.dispatched_on} value={form.commitment_date} onChange={set("commitment_date")} />
        </Field>
        <Field label="Given By" htmlFor="cj-gb">
          <Select id="cj-gb" value={form.given_by_id} onChange={set("given_by_id")}>
            <option value="">—</option>
            {(givenBy.data ?? [])
              .filter((g) => g.is_active)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Assigned staff user" htmlFor="cj-staff">
          <Select id="cj-staff" value={form.assigned_staff_id} onChange={set("assigned_staff_id")}>
            <option value="">—</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} ({u.role_label})
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description (optional)" htmlFor="cj-desc">
            <Input id="cj-desc" maxLength={2000} value={form.description} onChange={set("description")} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Remarks (optional)" htmlFor="cj-remarks" hint={`Saved as "From quotation ${cmp.request.request_no}" when empty`}>
            <Input id="cj-remarks" maxLength={2000} value={form.remarks} onChange={set("remarks")} />
          </Field>
        </div>
      </div>
      {form.commitment_date && <p className="text-xs text-slate-500">The committed date becomes the original commitment ({formatDate(form.commitment_date)}); later changes are recorded as revisions.</p>}
      {problem && <Alert tone="warning">{problem}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}
