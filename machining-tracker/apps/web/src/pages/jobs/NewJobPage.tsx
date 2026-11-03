import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDate } from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { useDateFormat } from "../../hooks/data";
import { useAssignableUsers, useCategories, useGivenBy } from "../../hooks/master";
import { AssignmentFields, assignmentPayload, assignmentProblem, emptyAssignment, type AssignmentDraft } from "../../components/jobForms";
import { Alert, Button, Card, Field, Input, PageHeader, Select, Textarea } from "../../components/ui";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function NewJobPage() {
  const { access } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const dateFormat = useDateFormat();
  const categories = useCategories();
  const givenBy = useGivenBy();
  const users = useAssignableUsers();
  const [form, setForm] = useState({ part_label: "", description: "", qty_sent: "", category_id: "", given_by_id: "", assigned_staff_id: access?.role_key === "staff" ? (access.user_id ?? "") : "", remarks: "" });
  const [sendNow, setSendNow] = useState(true);
  const [vendor, setVendor] = useState<AssignmentDraft>(emptyAssignment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const partQuery = useDebounced(form.part_label.trim(), 300);
  const history = useQuery({
    queryKey: ["part-search", partQuery],
    enabled: partQuery.length >= 2,
    queryFn: async () => unwrap(await supabase.rpc("search_part_labels", { p_query: partQuery, p_limit: 8 })) as Array<{ part_label: string; jobs: number; last_given: string | null }>,
  });
  const exact = history.data?.find((h) => h.part_label.toLowerCase() === form.part_label.trim().toLowerCase());

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const problem = !form.part_label.trim()
    ? "Enter the Part No / Part Name."
    : !form.category_id
      ? "Choose the work category."
      : form.qty_sent && !/^[1-9]\d*$/.test(form.qty_sent)
        ? "Quantity must be a whole number (or leave it empty if not known)."
        : sendNow
          ? assignmentProblem(vendor)
          : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = unwrap(
        await supabase.rpc("create_job", {
          p: {
            part_label: form.part_label.trim(),
            description: form.description,
            qty_sent: form.qty_sent ? Number(form.qty_sent) : null,
            category_id: form.category_id,
            given_by_id: form.given_by_id || null,
            assigned_staff_id: form.assigned_staff_id || null,
            remarks: form.remarks,
            vendor: sendNow ? assignmentPayload(vendor) : null,
          },
        }),
      ) as { id: string; job_no: string };
      await qc.invalidateQueries({ queryKey: ["jobs"] });
      await qc.invalidateQueries({ queryKey: ["job-tab-counts"] });
      navigate(`/jobs/${r.id}`, { state: { created: r.job_no } });
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="New job" description="Only the essentials. Job number, status and day counts are calculated automatically." />
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Card title="Part and work">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Part No / Part Name" htmlFor="nj-part" hint="One field, as in the Excel tracker, e.g. 4711 / Drive Shaft">
                <Input id="nj-part" list="nj-part-list" autoComplete="off" maxLength={200} value={form.part_label} onChange={set("part_label")} />
                <datalist id="nj-part-list">
                  {history.data?.map((h) => (
                    <option key={h.part_label} value={h.part_label} />
                  ))}
                </datalist>
              </Field>
              {exact && (
                <p className="mt-1 text-xs text-brand-700">
                  This part was outsourced {exact.jobs} time{exact.jobs === 1 ? "" : "s"} before
                  {exact.last_given ? `, last given ${formatDate(exact.last_given, dateFormat)}` : ""}.{" "}
                  <Link className="underline" to={`/jobs?tab=all&q=${encodeURIComponent(exact.part_label)}`} target="_blank">
                    See history
                  </Link>
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <Field label="Part description (optional)" htmlFor="nj-desc">
                <Textarea id="nj-desc" rows={2} maxLength={2000} value={form.description} onChange={set("description")} />
              </Field>
            </div>
            <Field label="Quantity sent" htmlFor="nj-qty" hint="Leave empty only if not known yet; it will be listed in Missing Data Review.">
              <Input id="nj-qty" inputMode="numeric" value={form.qty_sent} onChange={set("qty_sent")} />
            </Field>
            <Field label="Work / machining category" htmlFor="nj-cat">
              <Select id="nj-cat" value={form.category_id} onChange={set("category_id")}>
                <option value="">Choose</option>
                {categories.data?.filter((c) => c.is_active).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Given By" htmlFor="nj-gb">
              <Select id="nj-gb" value={form.given_by_id} onChange={set("given_by_id")}>
                <option value="">—</option>
                {givenBy.data?.filter((g) => g.is_active).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Assigned staff user" htmlFor="nj-staff" hint="The person who follows up this job. Staff see jobs assigned to them.">
              <Select id="nj-staff" value={form.assigned_staff_id} onChange={set("assigned_staff_id")}>
                <option value="">— nobody —</option>
                {users.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} ({u.role_label})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label="Remarks (optional)" htmlFor="nj-remarks">
                <Input id="nj-remarks" maxLength={2000} value={form.remarks} onChange={set("remarks")} />
              </Field>
            </div>
          </div>
        </Card>

        <Card
          title="Vendor"
          actions={
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} /> Give to a vendor now
            </label>
          }
        >
          {sendNow ? (
            <AssignmentFields draft={vendor} onChange={setVendor} categoryId={form.category_id} showQty={false} idPrefix="nj" />
          ) : (
            <p className="text-sm text-slate-600">The job is saved as a <strong>Draft</strong>. Send it to a vendor from the job page when ready.</p>
          )}
        </Card>

        {error && <Alert tone="error">{error}</Alert>}
        {problem && (form.part_label || form.category_id || vendor.vendor_id) && <Alert tone="warning">{problem}</Alert>}
        <div className="flex gap-2">
          <Button type="submit" loading={busy} disabled={!!problem}>
            {sendNow ? "Save and send to vendor" : "Save as draft"}
          </Button>
          <Link to="/jobs">
            <Button variant="secondary">Cancel</Button>
          </Link>
        </div>
      </form>
    </>
  );
}
