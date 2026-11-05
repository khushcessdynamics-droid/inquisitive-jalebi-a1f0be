import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../lib/supabase";
import { toAppError, unwrap } from "../../lib/errors";
import { ReclassifyDialog } from "../../components/jobForms";
import { Alert, Badge, Button, EmptyState, PageHeader, Spinner, Table, td, th } from "../../components/ui";

interface Issue {
  issue: "quantity_missing" | "commitment_missing" | "amount_missing" | "cancellation_unclassified";
  job_id: string;
  job_no: string;
  part_label: string;
  vendor_name: string | null;
  assignment_id: string | null;
  assignment_version: number | null;
  detail: string;
}

const ISSUE_LABEL: Record<Issue["issue"], [string, "amber" | "red" | "slate" | "blue"]> = {
  quantity_missing: ["Quantity missing", "amber"],
  commitment_missing: ["Commitment date missing", "blue"],
  amount_missing: ["Amount missing", "slate"],
  cancellation_unclassified: ["Cancellation not classified", "red"],
};

export function MissingDataPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Issue["issue"] | "">("");
  const [classify, setClassify] = useState<Issue | null>(null);
  const q = useQuery({
    queryKey: ["missing-data"],
    queryFn: async () => unwrap(await supabase.rpc("missing_data_review")) as Issue[],
  });
  const counts = (q.data ?? []).reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.issue]: (acc[i.issue] ?? 0) + 1 }), {});
  const rows = (q.data ?? []).filter((i) => !filter || i.issue === filter);
  return (
    <>
      <PageHeader
        title="Missing Data Review"
        description="Jobs saved or imported without full information. Nothing is guessed: these values stay empty until someone fills them in."
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <Button variant={filter === "" ? "primary" : "secondary"} onClick={() => setFilter("")}>
          All ({q.data?.length ?? 0})
        </Button>
        {(Object.keys(ISSUE_LABEL) as Issue["issue"][]).map((k) => (
          <Button key={k} variant={filter === k ? "primary" : "secondary"} onClick={() => setFilter(k)}>
            {ISSUE_LABEL[k][0]} ({counts[k] ?? 0})
          </Button>
        ))}
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <Alert tone="error">{toAppError(q.error).message}</Alert>
      ) : !rows.length ? (
        <EmptyState title="Nothing missing">All visible jobs have quantity, commitment date and amount, and every cancellation has a reason.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>What is missing</th>
              <th className={th}>Job</th>
              <th className={th}>Vendor</th>
              <th className={th}>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((i) => (
              <tr key={`${i.issue}-${i.job_id}-${i.assignment_id ?? ""}`}>
                <td className={td}>
                  <Badge tone={ISSUE_LABEL[i.issue][1]}>{ISSUE_LABEL[i.issue][0]}</Badge>
                  <p className="mt-1 text-xs text-slate-500">{i.detail}</p>
                </td>
                <td className={td}>
                  <Link to={`/jobs/${i.job_id}`} className="font-medium text-brand-700 hover:underline">
                    {i.job_no}
                  </Link>
                  <p className="text-xs text-slate-600">{i.part_label}</p>
                </td>
                <td className={td}>{i.vendor_name ?? "—"}</td>
                <td className={`${td} text-right`}>
                  {i.issue === "cancellation_unclassified" && can("jobs.cancel") ? (
                    <Button variant="secondary" onClick={() => setClassify(i)}>
                      Classify
                    </Button>
                  ) : (
                    <Link to={`/jobs/${i.job_id}`}>
                      <Button variant="secondary">Open job</Button>
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {classify?.assignment_id && (
        <ReclassifyDialog
          assignmentId={classify.assignment_id}
          version={classify.assignment_version ?? 0}
          jobId={classify.job_id}
          open
          onClose={() => setClassify(null)}
          onDone={() => void qc.invalidateQueries({ queryKey: ["missing-data"] })}
        />
      )}
    </>
  );
}
