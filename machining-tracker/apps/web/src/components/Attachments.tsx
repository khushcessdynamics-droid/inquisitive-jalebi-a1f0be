import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, Paperclip, Upload } from "lucide-react";
import { formatDateTimeIST } from "@cess/shared";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { toAppError, unwrap } from "../lib/errors";
import type { AttachmentRow } from "../lib/types";
import { useDateFormat, useRealtimeInvalidate, useSettings } from "../hooks/data";
import { Alert, Badge, Button, Card, EmptyState, ReasonDialog, Spinner } from "./ui";

function size(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, "_").slice(-120);
}

/** Drawings, quotations and photos for one job, in the private "job-files" storage bucket. */
export function AttachmentsCard({ jobId, assignmentId }: { jobId: string; assignmentId: string | null }) {
  const { can } = useAuth();
  const dateFormat = useDateFormat();
  const settings = useSettings();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<AttachmentRow | null>(null);
  useRealtimeInvalidate(["attachments"], ["job-attachments", jobId]);

  const list = useQuery({
    queryKey: ["job-attachments", jobId],
    queryFn: async () => unwrap(await supabase.from("attachments").select("*").eq("job_id", jobId).order("uploaded_at", { ascending: false })) as AttachmentRow[],
  });
  const conf = (settings.data?.attachments?.value ?? { max_file_mb: 50, allowed_extensions: [] }) as { max_file_mb: number; allowed_extensions: string[] };

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const ext = (file.name.split(".").pop() ?? "").toLowerCase();
        if (!conf.allowed_extensions.includes(ext)) throw new Error(`"${file.name}": file type .${ext} is not allowed (${conf.allowed_extensions.join(", ")}).`);
        if (file.size > conf.max_file_mb * 1024 * 1024) throw new Error(`"${file.name}" is larger than ${conf.max_file_mb} MB.`);
        if (file.size === 0) throw new Error(`"${file.name}" is empty.`);
        const path = `${jobId}/${crypto.randomUUID()}__${safeName(file.name)}`;
        const up = await supabase.storage.from("job-files").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
        if (up.error) throw new Error(`"${file.name}" could not be uploaded: ${up.error.message}`);
        const reg = await supabase.rpc("register_attachment", { p_job_id: jobId, p_storage_path: path, p_file_name: file.name, p_assignment_id: assignmentId });
        if (reg.error) {
          await supabase.storage.from("job-files").remove([path]); // clean up the unregistered file
          throw toAppError(reg.error);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
      await qc.invalidateQueries({ queryKey: ["job-attachments", jobId] });
      await qc.invalidateQueries({ queryKey: ["job-activity", jobId] });
    }
  }

  async function download(a: AttachmentRow) {
    setError(null);
    const { data, error: err } = await supabase.storage.from("job-files").createSignedUrl(a.storage_path, 60, { download: a.file_name });
    if (err || !data) {
      setError(err?.message ?? "Download failed");
      return;
    }
    await supabase.rpc("log_activity", { p_action: "attachment.downloaded", p_module: "attachments", p_entity_id: a.id, p_details: { file: a.file_name, job_id: jobId } });
    window.location.assign(data.signedUrl);
  }

  const rows = (list.data ?? []).filter((a) => showArchived || !a.archived_at);
  const archivedCount = (list.data ?? []).filter((a) => a.archived_at).length;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Paperclip className="h-4 w-4" /> Attachments
        </span>
      }
      actions={
        can("attachments.upload") && (
          <>
            <input ref={input} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} accept={conf.allowed_extensions.map((x) => `.${x}`).join(",")} />
            <Button variant="secondary" loading={busy} onClick={() => input.current?.click()}>
              <Upload className="h-4 w-4" /> Upload
            </Button>
          </>
        )
      }
    >
      {error && (
        <div className="mb-3">
          <Alert tone="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        </div>
      )}
      {list.isLoading ? (
        <Spinner />
      ) : !rows.length ? (
        <EmptyState title="No attachments">Drawings, quotations, delivery challans or photos (up to {conf.max_file_mb} MB each).</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className={a.archived_at ? "truncate text-sm text-slate-400 line-through" : "truncate text-sm font-medium text-slate-800"}>{a.file_name}</p>
                <p className="text-xs text-slate-500">
                  {a.extension.toUpperCase()} · {size(a.size_bytes)} · {formatDateTimeIST(a.uploaded_at, dateFormat)}
                  {a.archived_at && <> · archived: {a.archive_reason}</>}
                </p>
              </div>
              <div className="flex gap-1">
                {!a.archived_at && can("attachments.download") && (
                  <Button variant="ghost" onClick={() => void download(a)} aria-label={`Download ${a.file_name}`}>
                    <Download className="h-4 w-4" />
                  </Button>
                )}
                {!a.archived_at && can("attachments.archive") && (
                  <Button variant="ghost" onClick={() => setArchiving(a)} aria-label={`Archive ${a.file_name}`}>
                    <Archive className="h-4 w-4" />
                  </Button>
                )}
                {a.archived_at && <Badge>Archived</Badge>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {archivedCount > 0 && (
        <button type="button" className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? "Hide" : "Show"} {archivedCount} archived file{archivedCount === 1 ? "" : "s"}
        </button>
      )}
      <ReasonDialog
        open={!!archiving}
        title="Archive attachment?"
        message={<>The file <strong>{archiving?.file_name}</strong> is kept but can no longer be downloaded.</>}
        confirmLabel="Archive"
        danger
        onCancel={() => setArchiving(null)}
        onConfirm={async (reason) => {
          unwrap(await supabase.rpc("archive_attachment", { p_attachment_id: archiving!.id, p_reason: reason }));
          setArchiving(null);
          await qc.invalidateQueries({ queryKey: ["job-attachments", jobId] });
        }}
      />
    </Card>
  );
}
