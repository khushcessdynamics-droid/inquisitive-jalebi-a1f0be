import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  DATE_FORMATS,
  RELIABILITY_FACTORS,
  RELIABILITY_FACTOR_LABELS,
  formatDate,
  settingsSchemas,
  sumWeights,
  todayIST,
  type SettingKey,
} from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { AppError, toAppError, unwrap } from "../../lib/errors";
import type { CancelReasonRow, MasterRow, SettingRow } from "../../lib/types";
import { useRealtimeInvalidate, useSettings } from "../../hooks/data";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select, Spinner, Table, cx, td, th } from "../../components/ui";

type Tab = "company" | "localization" | "categories" | "given_by" | "cancel" | "reliability" | "jobs" | "security";

export function SettingsPage() {
  const { can } = useAuth();
  const tabs: Array<{ key: Tab; label: string; show: boolean }> = [
    { key: "company", label: "Company", show: can("settings.change") },
    { key: "localization", label: "Date & financial year", show: can("settings.change") },
    { key: "categories", label: "Work categories", show: can("settings.change") },
    { key: "given_by", label: "Given By names", show: can("settings.change") },
    { key: "cancel", label: "Cancellation reasons", show: can("settings.change") },
    { key: "reliability", label: "Reliability score", show: can("settings.change") },
    { key: "jobs", label: "Job thresholds", show: can("settings.change") },
    { key: "security", label: "Session security", show: can("users.manage") },
  ];
  const visible = tabs.filter((t) => t.show);
  const [tab, setTab] = useState<Tab>(visible[0]?.key ?? "company");
  const settings = useSettings();

  return (
    <>
      <PageHeader title="Settings" description="Every change is validated on the server and recorded in the activity history." />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {visible.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cx(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
              tab === t.key ? "border-brand-700 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {settings.isLoading ? (
        <Spinner />
      ) : settings.error ? (
        <Alert tone="error">{toAppError(settings.error).message}</Alert>
      ) : (
        <>
          {tab === "company" && <CompanyForm row={settings.data!.company!} />}
          {tab === "localization" && <LocalizationForm row={settings.data!.localization!} />}
          {tab === "categories" && <MasterList table="work_categories" title="Work / machining categories" />}
          {tab === "given_by" && <MasterList table="given_by_names" title="Given By names" />}
          {tab === "cancel" && <CancelReasons />}
          {tab === "reliability" && <ReliabilityForm row={settings.data!.reliability!} />}
          {tab === "jobs" && <JobsForm row={settings.data!.jobs!} />}
          {tab === "security" && <SecurityForm row={settings.data!.security!} />}
        </>
      )}
    </>
  );
}

/** Shared editing logic for one settings document: local draft, Zod check, versioned save. */
function useSettingDraft<T extends Record<string, unknown>>(key: SettingKey, row: SettingRow) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<T>(row.value as T);
  const [message, setMessage] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(row.value as T), [row.version, row.value]);
  const parsed = settingsSchemas[key].safeParse(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(row.value);
  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Invalid value", "validation");
      unwrap(await supabase.rpc("update_setting", { p_key: key, p_value: draft, p_expected_version: row.version }));
      setMessage({ tone: "success", text: "Saved." });
    } catch (e) {
      const err = toAppError(e);
      setMessage({ tone: err.kind === "conflict" ? "warning" : "error", text: err.message });
    } finally {
      setSaving(false);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  };
  const error = !parsed.success ? (parsed.error.issues[0]?.message ?? null) : null;
  return { draft, setDraft, save, saving, message, dirty, error };
}

function SaveBar({ s, children }: { s: { save: () => Promise<void>; saving: boolean; message: { tone: "success" | "error" | "warning"; text: string } | null; dirty: boolean; error: string | null }; children?: ReactNode }) {
  return (
    <div className="mt-4 space-y-3">
      {s.error && s.dirty && <Alert tone="warning">{s.error}</Alert>}
      {s.message && <Alert tone={s.message.tone}>{s.message.text}</Alert>}
      <div className="flex items-center gap-3">
        <Button onClick={() => void s.save()} loading={s.saving} disabled={!s.dirty || !!s.error}>
          Save changes
        </Button>
        {children}
      </div>
    </div>
  );
}

function CompanyForm({ row }: { row: SettingRow }) {
  const s = useSettingDraft<{ name: string; address: string; gstin: string; phone: string; email: string }>("company", row);
  const set = (k: keyof typeof s.draft) => (e: { target: { value: string } }) => s.setDraft({ ...s.draft, [k]: e.target.value });
  return (
    <Card title="Company information">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name" htmlFor="c-name">
          <Input id="c-name" value={s.draft.name} maxLength={120} onChange={set("name")} />
        </Field>
        <Field label="GSTIN (optional)" htmlFor="c-gst">
          <Input id="c-gst" value={s.draft.gstin} maxLength={15} onChange={(e) => s.setDraft({ ...s.draft, gstin: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Phone" htmlFor="c-phone">
          <Input id="c-phone" value={s.draft.phone} maxLength={30} onChange={set("phone")} />
        </Field>
        <Field label="Email" htmlFor="c-email">
          <Input id="c-email" type="email" value={s.draft.email} maxLength={120} onChange={set("email")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Address" htmlFor="c-addr">
            <Input id="c-addr" value={s.draft.address} maxLength={500} onChange={set("address")} />
          </Field>
        </div>
      </div>
      <SaveBar s={s} />
    </Card>
  );
}

function LocalizationForm({ row }: { row: SettingRow }) {
  const s = useSettingDraft<{ currency: string; timezone: string; date_format: (typeof DATE_FORMATS)[number]; fy_start_month: number }>("localization", row);
  const today = todayIST();
  return (
    <Card title="Date and financial year">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date format" htmlFor="l-fmt" hint={`Example: ${formatDate(today, s.draft.date_format)}`}>
          <Select id="l-fmt" value={s.draft.date_format} onChange={(e) => s.setDraft({ ...s.draft, date_format: e.target.value as (typeof DATE_FORMATS)[number] })}>
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Currency">
          <Input value="INR (₹)" disabled />
        </Field>
        <Field label="Timezone" hint="All due dates, delays and reports use Indian time.">
          <Input value="Asia/Kolkata (IST)" disabled />
        </Field>
        <Field label="Financial year">
          <Input value="April to March" disabled />
        </Field>
      </div>
      <SaveBar s={s} />
    </Card>
  );
}

function JobsForm({ row }: { row: SettingRow }) {
  const s = useSettingDraft<{ due_soon_days: number; long_pending_days: number }>("jobs", row);
  return (
    <Card title="Job status thresholds">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label='"Due soon" when the commitment date is within (days)' htmlFor="j-soon">
          <Input id="j-soon" type="number" min={1} max={30} value={s.draft.due_soon_days} onChange={(e) => s.setDraft({ ...s.draft, due_soon_days: Number(e.target.value) })} />
        </Field>
        <Field label="Long-pending alert after (days with the vendor)" htmlFor="j-long" hint="From the Excel tracker's late alert (default 10 days).">
          <Input id="j-long" type="number" min={1} max={365} value={s.draft.long_pending_days} onChange={(e) => s.setDraft({ ...s.draft, long_pending_days: Number(e.target.value) })} />
        </Field>
      </div>
      <SaveBar s={s} />
    </Card>
  );
}

function SecurityForm({ row }: { row: SettingRow }) {
  const s = useSettingDraft<{ idle_timeout_minutes: number; max_session_hours: number }>("security", row);
  return (
    <Card title="Session security (Admin only)">
      <p className="mb-4 text-sm text-slate-600">
        Enforced by the database on every request, so it also applies to anyone calling the API directly. Changes apply to existing sessions immediately.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sign out after inactivity (minutes)" htmlFor="s-idle">
          <Input id="s-idle" type="number" min={5} max={240} value={s.draft.idle_timeout_minutes} onChange={(e) => s.setDraft({ ...s.draft, idle_timeout_minutes: Number(e.target.value) })} />
        </Field>
        <Field label="Maximum session length (hours)" htmlFor="s-max">
          <Input id="s-max" type="number" min={1} max={72} value={s.draft.max_session_hours} onChange={(e) => s.setDraft({ ...s.draft, max_session_hours: Number(e.target.value) })} />
        </Field>
      </div>
      <SaveBar s={s} />
    </Card>
  );
}

type Reliability = {
  weights: Record<(typeof RELIABILITY_FACTORS)[number], number>;
  min_eligible_jobs: number;
  min_factors: number;
  delay_cap_days: number;
  stability_revisions_cap: number;
  labels: { excellent: number; good: number; average: number };
};

function ReliabilityForm({ row }: { row: SettingRow }) {
  const s = useSettingDraft<Reliability>("reliability", row);
  const total = sumWeights(s.draft.weights);
  const num = (v: string) => (v === "" ? Number.NaN : Number(v));
  return (
    <Card title="Vendor reliability score">
      <p className="mb-4 text-sm text-slate-600">
        Approved six-factor model. Weights must add up to 100. Only vendor-caused cancellations affect the score; jobs without the required data are
        excluded from that factor. The score itself is calculated by the Vendor Reliability module.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {RELIABILITY_FACTORS.map((f) => (
          <Field key={f} label={`${RELIABILITY_FACTOR_LABELS[f]} (%)`} htmlFor={`w-${f}`}>
            <Input
              id={`w-${f}`}
              type="number"
              min={0}
              max={100}
              step="0.5"
              value={Number.isNaN(s.draft.weights[f]) ? "" : s.draft.weights[f]}
              onChange={(e) => s.setDraft({ ...s.draft, weights: { ...s.draft.weights, [f]: num(e.target.value) } })}
            />
          </Field>
        ))}
      </div>
      <p className={cx("mt-2 text-sm font-medium", total === 100 ? "text-emerald-700" : "text-red-600")}>Total: {total} / 100</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Minimum eligible jobs for a score" htmlFor="r-min">
          <Input id="r-min" type="number" min={1} max={100} value={s.draft.min_eligible_jobs} onChange={(e) => s.setDraft({ ...s.draft, min_eligible_jobs: Number(e.target.value) })} />
        </Field>
        <Field label="Minimum factors with data" htmlFor="r-minf">
          <Input id="r-minf" type="number" min={1} max={6} value={s.draft.min_factors} onChange={(e) => s.setDraft({ ...s.draft, min_factors: Number(e.target.value) })} />
        </Field>
        <Field label="Delay cap (days)" htmlFor="r-cap" hint="Average late days at which delay score reaches 0.">
          <Input id="r-cap" type="number" min={1} max={365} value={s.draft.delay_cap_days} onChange={(e) => s.setDraft({ ...s.draft, delay_cap_days: Number(e.target.value) })} />
        </Field>
        <Field label="Revisions cap" hint="Revisions per job at which stability reaches 0." htmlFor="r-rev">
          <Input id="r-rev" type="number" min={1} max={10} value={s.draft.stability_revisions_cap} onChange={(e) => s.setDraft({ ...s.draft, stability_revisions_cap: Number(e.target.value) })} />
        </Field>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {(["excellent", "good", "average"] as const).map((k) => (
          <Field key={k} label={`"${k[0]!.toUpperCase()}${k.slice(1)}" from score`} htmlFor={`l-${k}`}>
            <Input id={`l-${k}`} type="number" min={0} max={100} value={s.draft.labels[k]} onChange={(e) => s.setDraft({ ...s.draft, labels: { ...s.draft.labels, [k]: Number(e.target.value) } })} />
          </Field>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">Below the "Average" threshold the label is "Needs Improvement".</p>
      <SaveBar s={s} />
    </Card>
  );
}

function MasterList({ table, title }: { table: "work_categories" | "given_by_names"; title: string }) {
  const queryClient = useQueryClient();
  useRealtimeInvalidate([table], [table]);
  const list = useQuery({
    queryKey: [table],
    queryFn: async () => unwrap(await supabase.from(table).select("id,name,is_active,sort_order,version").order("sort_order").order("name")) as MasterRow[],
  });
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const refresh = () => queryClient.invalidateQueries({ queryKey: [table] });

  async function update(row: MasterRow, patch: Partial<MasterRow>) {
    setError(null);
    try {
      const data = unwrap(await supabase.from(table).update(patch).eq("id", row.id).eq("version", row.version).select("id")) as unknown[];
      if (!data.length) throw new AppError("This entry was changed by someone else. The list has been reloaded.", "conflict");
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      await refresh();
    }
  }

  return (
    <Card title={title}>
      <p className="mb-3 text-sm text-slate-600">Entries are never deleted, so old records keep their values. Deactivate an entry to hide it from new jobs.</p>
      {list.isLoading ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Order</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.data?.map((row) => (
              <tr key={row.id}>
                <td className={td}>
                  <div className="flex gap-2">
                    <Input
                      aria-label={`Name for ${row.name}`}
                      value={editing[row.id] ?? row.name}
                      maxLength={80}
                      onChange={(e) => setEditing({ ...editing, [row.id]: e.target.value })}
                    />
                    {editing[row.id] !== undefined && editing[row.id] !== row.name && (
                      <Button
                        onClick={async () => {
                          await update(row, { name: editing[row.id]!.trim() });
                          setEditing(({ [row.id]: _drop, ...rest }) => rest);
                        }}
                        disabled={!editing[row.id]!.trim()}
                      >
                        Save
                      </Button>
                    )}
                  </div>
                </td>
                <td className={td}>
                  <Input
                    aria-label={`Order for ${row.name}`}
                    type="number"
                    className="w-20"
                    defaultValue={row.sort_order}
                    onBlur={(e) => Number(e.target.value) !== row.sort_order && void update(row, { sort_order: Number(e.target.value) })}
                  />
                </td>
                <td className={td}>
                  <button type="button" onClick={() => void update(row, { is_active: !row.is_active })} aria-label={`${row.is_active ? "Deactivate" : "Activate"} ${row.name}`}>
                    {row.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            unwrap(await supabase.from(table).insert({ name: newName.trim(), sort_order: (list.data?.length ?? 0) + 1 }));
            setNewName("");
          } catch (err) {
            setError(toAppError(err).message);
          } finally {
            await refresh();
          }
        }}
      >
        <Input aria-label="New entry" placeholder="Add new..." value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} />
        <Button type="submit" disabled={!newName.trim()}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </form>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

const SUBTYPES = [
  ["delivery", "Missed delivery commitment"],
  ["refusal", "Refused the work"],
  ["incomplete", "Could not complete the work"],
  ["quality", "Machining / quality problem"],
  ["repeated_commitment", "Repeated commitment failures"],
] as const;

function CancelReasons() {
  const queryClient = useQueryClient();
  useRealtimeInvalidate(["cancel_reason_codes"], ["cancel_reason_codes"]);
  const list = useQuery({
    queryKey: ["cancel_reason_codes"],
    queryFn: async () => unwrap(await supabase.from("cancel_reason_codes").select("*").order("sort_order")) as CancelReasonRow[],
  });
  const [label, setLabel] = useState("");
  const [vendorRelated, setVendorRelated] = useState(false);
  const [subtype, setSubtype] = useState<string>("delivery");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["cancel_reason_codes"] });

  async function toggle(row: CancelReasonRow) {
    setError(null);
    try {
      const data = unwrap(await supabase.from("cancel_reason_codes").update({ is_active: !row.is_active }).eq("code", row.code).eq("version", row.version).select("code")) as unknown[];
      if (!data.length) throw new AppError("Changed by someone else. Reloaded.", "conflict");
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      await refresh();
    }
  }

  return (
    <Card title="Cancellation reasons">
      <p className="mb-3 text-sm text-slate-600">
        A reason is mandatory when a job is cancelled. Only <strong>vendor-caused</strong> reasons lower the vendor's reliability score. Built-in reasons keep
        their classification.
      </p>
      {list.isLoading ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Reason</th>
              <th className={th}>Affects vendor score</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.data?.map((r) => (
              <tr key={r.code}>
                <td className={td}>
                  {r.label}
                  {r.is_system && <span className="ml-2 text-xs text-slate-400">built-in</span>}
                </td>
                <td className={td}>
                  {r.vendor_related ? <Badge tone="red">Yes · {SUBTYPES.find((s) => s[0] === r.vendor_subtype)?.[1]}</Badge> : <Badge>No</Badge>}
                </td>
                <td className={td}>
                  <button type="button" onClick={() => void toggle(r)} aria-label={`${r.is_active ? "Deactivate" : "Activate"} ${r.label}`}>
                    {r.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const code = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
          try {
            if (code.length < 3) throw new AppError("Reason is too short.", "validation");
            unwrap(
              await supabase.from("cancel_reason_codes").insert({
                code,
                label: label.trim(),
                vendor_related: vendorRelated,
                vendor_subtype: vendorRelated ? subtype : null,
                sort_order: (list.data?.length ?? 0) + 1,
              }),
            );
            setLabel("");
          } catch (err) {
            setError(toAppError(err).message);
          } finally {
            await refresh();
          }
        }}
      >
        <Field label="New reason" htmlFor="cr-label">
          <Input id="cr-label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={vendorRelated} onChange={(e) => setVendorRelated(e.target.checked)} /> Vendor-caused
        </label>
        <Select aria-label="Vendor failure type" disabled={!vendorRelated} value={subtype} onChange={(e) => setSubtype(e.target.value)}>
          {SUBTYPES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={label.trim().length < 3}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </form>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </Card>
  );
}
