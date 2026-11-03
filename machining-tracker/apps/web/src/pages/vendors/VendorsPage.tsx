import { useEffect, useMemo, useState } from "react";
import { ChangedMeanwhileNotice, changedSince, useOpenSnapshot } from "../../hooks/editSnapshot";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Plus } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import type { VendorRow } from "../../lib/types";
import { useCategories, useVendors } from "../../hooks/master";
import { downloadWorkbook, type ExportSheet } from "../../lib/excel";
import { Alert, Badge, Button, EmptyState, Field, Input, Modal, PageHeader, Spinner, Table, Textarea, td, th } from "../../components/ui";

const blank = {
  name: "",
  company_name: "",
  contact_person: "",
  mobile: "",
  wa_country_code: "+91",
  wa_number: "",
  email: "",
  address: "",
  gst_no: "",
  payment_terms: "",
  remarks: "",
  is_active: true,
  category_ids: [] as string[],
};
type VendorForm = typeof blank;

function problem(f: VendorForm): string | null {
  if (!f.name.trim()) return "Vendor name is required.";
  if (f.mobile && !/^[0-9+ ()-]{6,20}$/.test(f.mobile)) return "Mobile number may contain only digits, spaces, +, - and brackets.";
  if (f.wa_number && !/^[0-9]{6,15}$/.test(f.wa_number.replace(/\s/g, ""))) return "WhatsApp number: digits only, without the country code.";
  if (!/^\+[0-9]{1,4}$/.test(f.wa_country_code)) return "Country code must look like +91.";
  if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return "Email address is not valid.";
  if (f.gst_no && !/^[0-9]{2}[A-Z0-9]{13}$/.test(f.gst_no.toUpperCase())) return "GST number must be 15 characters (2 digits + 13 letters/digits).";
  return null;
}

export function VendorDialog({ vendor: current, open, onClose, onSaved }: { vendor: VendorRow | null; open: boolean; onClose: () => void; onSaved?: (id: string) => void }) {
  const vendor = useOpenSnapshot(open, current);
  const changedMeanwhile = open && changedSince(vendor, current);
  const categories = useCategories();
  const qc = useQueryClient();
  const [f, setF] = useState<VendorForm>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setF(
      vendor
        ? {
            name: vendor.name,
            company_name: vendor.company_name,
            contact_person: vendor.contact_person,
            mobile: vendor.mobile,
            wa_country_code: vendor.wa_country_code,
            wa_number: vendor.wa_number,
            email: vendor.email,
            address: vendor.address,
            gst_no: vendor.gst_no,
            payment_terms: vendor.payment_terms,
            remarks: vendor.remarks,
            is_active: vendor.is_active,
            category_ids: (vendor.vendor_categories ?? []).map((c) => c.work_category_id),
          }
        : blank,
    );
  }, [open, vendor]);
  const set = (k: keyof VendorForm) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const p = problem(f);
  return (
    <Modal
      open={open}
      title={vendor ? `Edit ${vendor.vendor_code}` : "Add vendor"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!!p}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const saved = unwrap(
                  await supabase.rpc("save_vendor", {
                    p_vendor_id: vendor?.id ?? null,
                    p_expected_version: vendor?.version ?? null,
                    p: { ...f, gst_no: f.gst_no.toUpperCase(), wa_number: f.wa_number.replace(/\s/g, "") },
                  }),
                ) as { id: string };
                await qc.invalidateQueries({ queryKey: ["vendors"] });
                await qc.invalidateQueries({ queryKey: ["vendor", saved.id] });
                onSaved?.(saved.id);
                onClose();
              } catch (e) {
                setError(toAppError(e).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save vendor
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendor name (as used on jobs)" htmlFor="vd-name">
          <Input id="vd-name" maxLength={120} value={f.name} onChange={set("name")} />
        </Field>
        <Field label="Company name" htmlFor="vd-company">
          <Input id="vd-company" maxLength={200} value={f.company_name} onChange={set("company_name")} />
        </Field>
        <Field label="Contact person" htmlFor="vd-contact">
          <Input id="vd-contact" maxLength={120} value={f.contact_person} onChange={set("contact_person")} />
        </Field>
        <Field label="Mobile number" htmlFor="vd-mobile">
          <Input id="vd-mobile" inputMode="tel" maxLength={20} value={f.mobile} onChange={set("mobile")} />
        </Field>
        <Field label="WhatsApp number" htmlFor="vd-wa" hint="Country code + number without spaces or leading 0.">
          <div className="flex gap-2">
            <Input aria-label="WhatsApp country code" className="w-20" maxLength={5} value={f.wa_country_code} onChange={set("wa_country_code")} />
            <Input id="vd-wa" inputMode="numeric" maxLength={15} value={f.wa_number} onChange={set("wa_number")} />
          </div>
          {f.mobile && !f.wa_number && (
            <button type="button" className="mt-1 text-xs text-brand-700 hover:underline" onClick={() => setF({ ...f, wa_number: f.mobile.replace(/\D/g, "").replace(/^(91)(?=\d{10}$)/, "").replace(/^0/, "") })}>
              Same as mobile
            </button>
          )}
        </Field>
        <Field label="Email" htmlFor="vd-email">
          <Input id="vd-email" type="email" maxLength={120} value={f.email} onChange={set("email")} />
        </Field>
        <Field label="GST number (optional)" htmlFor="vd-gst">
          <Input id="vd-gst" maxLength={15} value={f.gst_no} onChange={(e) => setF({ ...f, gst_no: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="Payment terms (optional)" htmlFor="vd-terms">
          <Input id="vd-terms" maxLength={200} value={f.payment_terms} onChange={set("payment_terms")} placeholder="e.g. 30 days after delivery" />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Address" htmlFor="vd-address">
            <Textarea id="vd-address" rows={2} maxLength={500} value={f.address} onChange={set("address")} />
          </Field>
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium text-slate-700">Work categories this vendor does</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {categories.data?.filter((c) => c.is_active || f.category_ids.includes(c.id)).map((c) => (
              <label key={c.id} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={f.category_ids.includes(c.id)}
                  onChange={(e) => setF({ ...f, category_ids: e.target.checked ? [...f.category_ids, c.id] : f.category_ids.filter((x) => x !== c.id) })}
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="sm:col-span-2">
          <Field label="Notes" htmlFor="vd-notes">
            <Textarea id="vd-notes" rows={2} maxLength={1000} value={f.remarks} onChange={set("remarks")} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active (can receive new jobs)
        </label>
      </div>
      {p && f.name && <Alert tone="warning">{p}</Alert>}
      <ChangedMeanwhileNotice show={changedMeanwhile} what="this vendor" />
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

export function VendorsPage() {
  const { can } = useAuth();
  const vendors = useVendors();
  const categories = useCategories();
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const catName = useMemo(() => Object.fromEntries((categories.data ?? []).map((c) => [c.id, c.name])), [categories.data]);
  const rows = (vendors.data ?? []).filter(
    (v) => (showInactive || v.is_active) && (!q.trim() || `${v.name} ${v.company_name} ${v.vendor_code} ${v.contact_person} ${v.mobile}`.toLowerCase().includes(q.trim().toLowerCase())),
  );

  async function exportVendors() {
    setExportError(null);
    try {
      const sheet: ExportSheet<VendorRow> = {
        name: "Vendor Master",
        rows: vendors.data ?? [],
        columns: [
          { header: "Vendor ID", value: (v) => v.vendor_code },
          { header: "Vendor Name", value: (v) => v.name, width: 24 },
          { header: "Company Name", value: (v) => v.company_name, width: 28 },
          { header: "Contact Person", value: (v) => v.contact_person, width: 18 },
          { header: "Mobile", value: (v) => v.mobile, width: 16 },
          { header: "WhatsApp", value: (v) => (v.wa_number ? `${v.wa_country_code} ${v.wa_number}` : ""), width: 16 },
          { header: "Email", value: (v) => v.email, width: 24 },
          { header: "Work Categories", value: (v) => (v.vendor_categories ?? []).map((c) => catName[c.work_category_id]).join(", "), width: 30 },
          { header: "GST No", value: (v) => v.gst_no, width: 18 },
          { header: "Payment Terms", value: (v) => v.payment_terms, width: 20 },
          { header: "Address", value: (v) => v.address, width: 30 },
          { header: "Active", value: (v) => (v.is_active ? "Yes" : "No") },
          { header: "Notes", value: (v) => v.remarks, width: 24 },
        ],
      };
      await downloadWorkbook(`CESS-Vendor-Master-${new Date().toISOString().slice(0, 10)}.xlsx`, [sheet]);
      await supabase.rpc("log_activity", { p_action: "data.exported", p_module: "vendors", p_details: { what: "vendor master", rows: vendors.data?.length ?? 0 } });
    } catch (e) {
      setExportError(toAppError(e).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Vendor master. Names must be unique; vendors are never deleted (mark inactive instead)."
        actions={
          <>
            {can("reports.export") && (
              <Button variant="secondary" onClick={() => void exportVendors()}>
                <Download className="h-4 w-4" /> Export to Excel
              </Button>
            )}
            {can("vendors.manage") && (
              <Button onClick={() => setAdding(true)}>
                <Plus className="h-4 w-4" /> Add vendor
              </Button>
            )}
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-72">
          <Field label="Search" htmlFor="v-q">
            <Input id="v-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, code, contact, phone" />
          </Field>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
        </label>
      </div>
      {exportError && <Alert tone="error">{exportError}</Alert>}
      {vendors.isLoading ? (
        <Spinner />
      ) : vendors.error ? (
        <Alert tone="error">{toAppError(vendors.error).message}</Alert>
      ) : !rows.length ? (
        <EmptyState title={vendors.data?.length ? "No vendor matches" : "No vendors yet"}>{can("vendors.manage") && !vendors.data?.length ? "Add vendors here or import them from Excel." : null}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Vendor</th>
              <th className={th}>Categories</th>
              <th className={th}>Contact</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((v) => (
              <tr key={v.id} className="hover:bg-slate-50">
                <td className={td}>
                  <Link to={`/vendors/${v.id}`} className="font-medium text-brand-700 hover:underline">
                    {v.name}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {v.vendor_code}
                    {v.company_name ? ` · ${v.company_name}` : ""}
                  </p>
                </td>
                <td className={td}>
                  <div className="flex flex-wrap gap-1">
                    {(v.vendor_categories ?? []).map((c) => (
                      <Badge key={c.work_category_id}>{catName[c.work_category_id]}</Badge>
                    ))}
                  </div>
                </td>
                <td className={`${td} text-xs`}>
                  {v.contact_person && <p>{v.contact_person}</p>}
                  {v.mobile && <p>{v.mobile}</p>}
                </td>
                <td className={td}>{v.is_active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <VendorDialog vendor={null} open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
