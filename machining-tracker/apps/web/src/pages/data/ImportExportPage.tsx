import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, Upload } from "lucide-react";
import {
  JOB_TEMPLATE_HEADERS,
  VENDOR_TEMPLATE_HEADERS,
  parseJobsSheet,
  parseVendorsSheet,
  toImportPayload,
  type JobsParseResult,
  type ParsedVendorRow,
} from "@cess/shared";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { downloadWorkbook, readWorkbook, type ExportSheet } from "../../lib/excel";
import { Alert, Badge, Button, Card, PageHeader, ReasonDialog, Spinner, Table, td, th } from "../../components/ui";

interface ServerResult {
  dry_run: boolean;
  batch_id: string | null;
  imported: number;
  duplicates: number;
  errors: number;
  results: Array<{ ref: string; part_label?: string; name?: string; status: "imported" | "duplicate" | "error"; message?: string; job_no?: string; job_id?: string; outcome?: string; vendor_code?: string; warnings?: string[] }>;
}

function ResultTable({ result, kind }: { result: ServerResult; kind: "jobs" | "vendors" }) {
  return (
    <>
      <p className="mb-2 text-sm text-slate-700">
        {result.dry_run ? "Preview (nothing saved yet): " : "Saved: "}
        <strong>{result.imported}</strong> {result.dry_run ? "can be imported" : "imported"}, <strong>{result.duplicates}</strong> already in the system,{" "}
        <strong className={result.errors ? "text-red-700" : ""}>{result.errors}</strong> with errors.
      </p>
      <Table>
        <thead>
          <tr>
            <th className={th}>Excel row(s)</th>
            <th className={th}>{kind === "jobs" ? "Part No / Name" : "Vendor"}</th>
            <th className={th}>Result</th>
            <th className={th}>Details</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {result.results.map((r, i) => (
            <tr key={`${r.ref}-${i}`}>
              <td className={`${td} whitespace-nowrap text-xs`}>{r.ref}</td>
              <td className={td}>{kind === "jobs" ? r.part_label : r.name}</td>
              <td className={td}>
                {r.status === "imported" ? (
                  <Badge tone="green">{result.dry_run ? "OK" : "Imported"}</Badge>
                ) : r.status === "duplicate" ? (
                  <Badge>Already exists</Badge>
                ) : (
                  <Badge tone="red">Error</Badge>
                )}
                {r.outcome && <span className="ml-1 text-xs text-slate-500">{r.outcome}</span>}
              </td>
              <td className={`${td} text-xs`}>
                {r.job_id && !result.dry_run ? (
                  <Link to={`/jobs/${r.job_id}`} className="text-brand-700 hover:underline">
                    {r.job_no}
                  </Link>
                ) : null}
                {r.vendor_code && <span>{r.vendor_code}</span>}
                {r.message && <p className={r.status === "error" ? "text-red-700" : "text-slate-600"}>{r.message}</p>}
                {r.warnings?.map((w) => (
                  <p key={w} className="text-amber-700">
                    {w}
                  </p>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

export function ImportExportPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; sha256: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobsParseResult | null>(null);
  const [vendors, setVendors] = useState<ParsedVendorRow[] | null>(null);
  const [createVendors, setCreateVendors] = useState(false);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [jobResult, setJobResult] = useState<ServerResult | null>(null);
  const [vendorResult, setVendorResult] = useState<ServerResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"jobs" | "vendors" | null>(null);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setReading(true);
    setReadError(null);
    setJobs(null);
    setVendors(null);
    setJobResult(null);
    setVendorResult(null);
    setError(null);
    try {
      if (f.size > 20 * 1024 * 1024) throw new Error("The workbook is larger than 20 MB.");
      const { sheets, sha256 } = await readWorkbook(f);
      setFile({ name: f.name, sha256 });
      const j = parseJobsSheet(sheets);
      if (!("error" in j)) setJobs(j);
      const v = parseVendorsSheet(sheets);
      if (v) setVendors(v.rows);
      if ("error" in j && !v) throw new Error(`${j.error} No vendor sheet was found either.`);
    } catch (e) {
      setReadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  }

  async function runJobs(dryRun: boolean) {
    if (!jobs || !file) return;
    setBusy(dryRun ? "check-jobs" : "import-jobs");
    setError(null);
    try {
      const r = unwrap(
        await supabase.rpc("import_jobs", {
          p_file_name: file.name,
          p_file_sha256: file.sha256,
          p_jobs: toImportPayload(jobs.groups),
          p_options: { dry_run: dryRun, create_missing_vendors: createVendors, allow_duplicates: allowDuplicates },
        }),
      ) as ServerResult;
      setJobResult(r);
      if (!dryRun) {
        await qc.invalidateQueries({ queryKey: ["jobs"] });
        await qc.invalidateQueries({ queryKey: ["vendors"] });
      }
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(null);
    }
  }

  async function runVendors(dryRun: boolean) {
    if (!vendors || !file) return;
    setBusy(dryRun ? "check-vendors" : "import-vendors");
    setError(null);
    try {
      const r = unwrap(
        await supabase.rpc("import_vendors", {
          p_file_name: file.name,
          p_file_sha256: file.sha256,
          p_vendors: vendors.map((v) => ({ ref: v.ref, name: v.name, company_name: v.company_name, category_name: v.category_name, address: v.address, mobile: v.mobile, email: v.email, gst_no: v.gst_no, contact_person: v.contact_person })),
          p_options: { dry_run: dryRun },
        }),
      ) as ServerResult;
      setVendorResult(r);
      if (!dryRun) await qc.invalidateQueries({ queryKey: ["vendors"] });
    } catch (e) {
      setError(toAppError(e).message);
    } finally {
      setBusy(null);
    }
  }

  async function downloadTemplate(kind: "jobs" | "vendors") {
    const headers = kind === "jobs" ? JOB_TEMPLATE_HEADERS : VENDOR_TEMPLATE_HEADERS;
    const sheet: ExportSheet<{ x: null }> = { name: kind === "jobs" ? "Jobs" : "Vendors", rows: [], columns: headers.map((h) => ({ header: h, value: () => null, width: Math.max(14, h.length + 4) })) };
    const help: ExportSheet<{ text: string }> = {
      name: "How to fill",
      rows: (kind === "jobs"
        ? [
            "One row per vendor assignment. Dates as DD-MM-YYYY (or Excel dates).",
            "Work Category and Given By must match the names in Settings; Vendor Name must exist in the vendor master (or allow creating missing vendors).",
            "Leave Quantity, Committed Date or Amount empty if not known: they stay empty and appear in Missing Data Review.",
            "Cancelled & forwarded: fill Cancelled On + Forwarded To on the old row and add a later row for the same part with the new vendor.",
            "Date Returned marks the job as returned (imported as completed with a recorded note).",
          ]
        : ["One row per vendor. Vendor Name must be unique.", "GST No: 15 characters or empty.", "Work Category must match a category in Settings."]
      ).map((text) => ({ text })),
      columns: [{ header: "Instructions", value: (r) => r.text, width: 120 }],
    };
    await downloadWorkbook(`CESS-${kind === "jobs" ? "Jobs" : "Vendors"}-Import-Template.xlsx`, [sheet, help]);
  }

  if (!can("data.import") && !can("reports.export")) {
    return <Alert tone="warning">You do not have permission for Excel import or export.</Alert>;
  }

  return (
    <>
      <PageHeader title="Excel import & export" description="Bring in the existing Excel tracker, or download data and templates. The original workbook is never changed." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Templates and exports">
          <div className="space-y-2">
            <Button variant="secondary" className="w-full" onClick={() => void downloadTemplate("jobs")}>
              <FileSpreadsheet className="h-4 w-4" /> Jobs import template
            </Button>
            <Button variant="secondary" className="w-full" onClick={() => void downloadTemplate("vendors")}>
              <FileSpreadsheet className="h-4 w-4" /> Vendors import template
            </Button>
            {can("reports.export") && (
              <p className="pt-2 text-sm text-slate-600">
                Export the <Link to="/jobs?tab=all" className="text-brand-700 hover:underline">Jobs Register</Link> (any filter) or the{" "}
                <Link to="/vendors" className="text-brand-700 hover:underline">Vendor master</Link> with the Export button on those pages.
              </p>
            )}
          </div>
        </Card>

        {can("data.import") && (
          <Card title="Import from Excel" className="lg:col-span-2">
            <p className="mb-3 text-sm text-slate-600">
              Accepts <strong>CESS_Machining_Job_Tracker.xlsx</strong> (ENTRY and VENDORS sheets) or the templates. Every row is checked by the server in a preview
              first; nothing is saved until you confirm.
            </p>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-400 px-4 py-3 text-sm hover:bg-slate-50">
              <Upload className="h-4 w-4" />
              <span>{file ? file.name : "Choose an .xlsx file"}</span>
              <input type="file" accept=".xlsx" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
            {reading && <Spinner label="Reading workbook..." />}
            {readError && <div className="mt-3"><Alert tone="error">{readError}</Alert></div>}
            {(jobs || vendors) && (
              <div className="mt-3 space-y-1 text-sm text-slate-700">
                {vendors && <p>Vendor sheet: <strong>{vendors.length}</strong> vendor row(s).</p>}
                {jobs && (
                  <p>
                    Job sheet "{jobs.sheet}" ({jobs.layout === "cess-tracker" ? "original Excel tracker" : "import template"}): <strong>{jobs.rows.length}</strong> valid row(s) forming{" "}
                    <strong>{jobs.groups.length}</strong> job(s); <strong className={jobs.rowErrors.length ? "text-red-700" : ""}>{jobs.rowErrors.length}</strong> row(s) with problems.
                  </p>
                )}
                {jobs && jobs.rows.length === 0 && jobs.rowErrors.length === 0 && <Alert tone="info">The job sheet has no data rows (the original workbook is an empty template).</Alert>}
              </div>
            )}
            {jobs && jobs.rowErrors.length > 0 && (
              <div className="mt-3">
                <Alert tone="warning" title="Rows that will not be imported (fix them in Excel and choose the file again)">
                  <ul className="list-disc pl-5">
                    {jobs.rowErrors.slice(0, 50).map((e) => (
                      <li key={e.rowNumber}>Row {e.rowNumber}: {e.message}</li>
                    ))}
                  </ul>
                </Alert>
              </div>
            )}
            {jobs && jobs.groups.some((g) => g.warnings.length) && (
              <div className="mt-3">
                <Alert tone="info" title="Notes about cancel-and-forward rows">
                  <ul className="list-disc pl-5">
                    {jobs.groups.flatMap((g) => g.warnings.map((w) => <li key={`${g.ref}-${w}`}>{g.part_label}: {w}</li>))}
                  </ul>
                </Alert>
              </div>
            )}
            {error && <div className="mt-3"><Alert tone="error">{error}</Alert></div>}
          </Card>
        )}
      </div>

      {can("data.import") && vendors && vendors.length > 0 && (
        <Card title={`Step 1: vendors (${vendors.length})`} className="mt-4" actions={
          <div className="flex gap-2">
            <Button variant="secondary" loading={busy === "check-vendors"} disabled={!!busy} onClick={() => void runVendors(true)}>Check</Button>
            <Button loading={busy === "import-vendors"} disabled={!!busy || !vendorResult?.dry_run || vendorResult.imported === 0} onClick={() => setConfirm("vendors")}>Import vendors</Button>
          </div>
        }>
          {vendorResult ? <ResultTable result={vendorResult} kind="vendors" /> : <p className="text-sm text-slate-600">Import vendors first so the jobs can refer to them. Press Check to preview.</p>}
        </Card>
      )}

      {can("data.import") && jobs && jobs.groups.length > 0 && (
        <Card title={`Step 2: jobs (${jobs.groups.length})`} className="mt-4" actions={
          <div className="flex gap-2">
            <Button variant="secondary" loading={busy === "check-jobs"} disabled={!!busy} onClick={() => void runJobs(true)}>Check</Button>
            <Button loading={busy === "import-jobs"} disabled={!!busy || !jobResult?.dry_run || jobResult.imported === 0} onClick={() => setConfirm("jobs")}>Import jobs</Button>
          </div>
        }>
          <div className="mb-3 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={createVendors} onChange={(e) => { setCreateVendors(e.target.checked); setJobResult(null); }} /> Create vendors that are not in the vendor master
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={allowDuplicates} onChange={(e) => { setAllowDuplicates(e.target.checked); setJobResult(null); }} /> Import rows that look like duplicates
            </label>
          </div>
          {jobResult ? <ResultTable result={jobResult} kind="jobs" /> : <p className="text-sm text-slate-600">Press Check to let the server validate every job (nothing is saved).</p>}
        </Card>
      )}

      <ReasonDialog
        open={!!confirm}
        title={confirm === "jobs" ? "Import jobs now?" : "Import vendors now?"}
        message={
          confirm === "jobs"
            ? `${jobResult?.imported ?? 0} job(s) will be created exactly as previewed. Rows with errors or duplicates are skipped. Every imported job is recorded in the activity history.`
            : `${vendorResult?.imported ?? 0} vendor(s) will be created. Existing vendors are not changed.`
        }
        confirmLabel="Import"
        requireReason={false}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const which = confirm;
          setConfirm(null);
          if (which === "jobs") await runJobs(false);
          else await runVendors(false);
        }}
      />
    </>
  );
}
