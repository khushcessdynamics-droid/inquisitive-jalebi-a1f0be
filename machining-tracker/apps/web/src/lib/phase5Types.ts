// Shapes returned by the Phase 5 database functions (commitment history, reliability, cost comparison).
import type { ReliabilityFactor } from "@cess/shared";

export interface CommitmentRevisionRow {
  id: string;
  assignment_id: string;
  job_id: string;
  vendor_id: string;
  revision_no: number;
  original_date: string;
  previous_date: string;
  new_date: string;
  days_moved: number;
  days_from_original: number;
  changed_on: string;
  requested_by: "vendor" | "cess";
  reason: string;
  created_at: string;
  changed_by_name: string | null;
  job_no: string;
  part_label: string;
  vendor_name: string;
}

export interface ReliabilityFactorResult {
  key: ReliabilityFactor;
  weight: number;
  score: number | null;
  jobs: number;
  used: boolean;
  note: string;
}

export type ReliabilityStatus = "scored" | "insufficient_jobs" | "insufficient_factors";
export type ReliabilityLabel = "Excellent" | "Good" | "Average" | "Needs Improvement";

export interface ReliabilityRow {
  vendor_id: string;
  vendor_name: string;
  category_id: string | null;
  category_name: string | null;
  score: number | null;
  label: ReliabilityLabel | null;
  status: ReliabilityStatus;
  rank: number | null;
  eligible_jobs: number;
  min_eligible_jobs: number;
  factors_used: number;
  min_factors: number;
  weight_used: number;
  factors: ReliabilityFactorResult[];
  counts: {
    total: number;
    completed: number;
    vendor_cancelled: number;
    other_cancelled: number;
    unclassified_cancelled: number;
    open: number;
    open_committed: number;
    overdue_now: number;
    closed_no_return: number;
    completed_no_commitment: number;
    committed_completed: number;
    on_time: number;
    late: number;
  };
  measures: {
    on_time_pct: number | null;
    overdue_now_pct: number | null;
    avg_delay_when_late: number | null;
    avg_delay_when_late_vs_latest: number | null;
    late_vs_latest: number;
    avg_delay_all: number | null;
    total_delay_days: number;
    avg_days_taken: number | null;
    quality_acceptance_pct: number | null;
    rework_rejection_pct: number | null;
    revisions: number;
    revisions_vendor: number;
    revisions_per_committed_job: number | null;
    revised_jobs: number;
    committed_jobs: number;
    max_revisions_one_job: number;
    frequent_reviser: boolean;
  };
  cancel_reasons: Array<{ code: string; label: string; vendor_caused: boolean; count: number }>;
}

export interface ReliabilityResult {
  settings: {
    weights: Record<ReliabilityFactor, number>;
    min_eligible_jobs: number;
    min_factors: number;
    delay_cap_days: number;
    stability_revisions_cap: number;
    labels: { excellent: number; good: number; average: number };
  };
  from: string | null;
  to: string | null;
  category_id: string | null;
  by_category: boolean;
  today: string;
  rows: ReliabilityRow[];
}

export type ReliabilityBucket = "completed" | "vendor_cancelled" | "other_cancelled" | "unclassified_cancelled" | "open" | "closed_no_return";

export interface ReliabilityJob {
  assignment_id: string;
  job_id: string;
  job_no: string;
  part_label: string;
  category_name: string;
  sequence_no: number;
  dispatched_on: string;
  original_commitment_date: string | null;
  current_commitment_date: string | null;
  completed_on: string | null;
  cancelled_on: string | null;
  cancel_reason_code: string | null;
  cancel_reason_label: string | null;
  bucket: ReliabilityBucket;
  days_taken: number | null;
  late_days: number | null;
  late_days_current: number | null;
  revisions: number;
  vendor_revisions: number;
  overdue_now: boolean;
  category_median_days: number | null;
  used_in: ReliabilityFactor[];
  excluded_because: string | null;
}

export interface QuotationRequestRow {
  id: string;
  request_no: string;
  part_label: string;
  category_id: string;
  qty: number;
  required_by: string | null;
  remarks: string;
  status: "open" | "decided" | "job_created" | "closed";
  selected_quotation_id: string | null;
  recommended_quotation_id: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  job_id: string | null;
  closed_reason: string | null;
  created_at: string;
  version: number;
  category_name?: string;
  job_no?: string | null;
  decided_by_name?: string | null;
  created_by_name?: string | null;
}

export interface QuotationListRow {
  id: string;
  request_no: string;
  part_label: string;
  category_name: string;
  qty: number;
  required_by: string | null;
  status: QuotationRequestRow["status"];
  created_at: string;
  job_id: string | null;
  job_no: string | null;
  quotes: number;
  lowest: number | null;
  selected_vendor: string | null;
}

export interface ComparedQuote {
  id: string;
  version: number;
  vendor_id: string;
  vendor_name: string;
  vendor_code: string;
  quote_date: string;
  basis: "per_part" | "total";
  price: number;
  delivery_days: number | null;
  quote_ref: string;
  remarks: string;
  total: number;
  per_part: number;
  reliability: { score: number | null; label: string | null; basis: "category" | "overall" | null; eligible_jobs: number; min_eligible_jobs?: number };
  on_time_pct: number | null;
  stale: boolean;
  misses_required_date: boolean;
  diff_vs_lowest: number;
  diff_vs_lowest_pct: number | null;
  diff_vs_average: number;
  diff_vs_average_pct: number | null;
  price_score: number;
  delivery_score: number | null;
  value_score: number | null;
  is_lowest: boolean;
  is_highest: boolean;
  is_fastest: boolean;
}

export interface PartHistoryRow {
  job_id: string;
  job_no: string;
  part_label?: string;
  category_name?: string;
  vendor_id: string;
  vendor_name: string;
  dispatched_on: string;
  qty: number | null;
  amount: number | null;
  per_part: number | null;
  state: string;
  days_taken?: number | null;
}

export interface QuoteHistoryRow {
  request_id: string;
  request_no: string;
  part_label?: string;
  category_name?: string;
  vendor_id?: string;
  vendor_name: string;
  quote_date: string;
  qty: number;
  per_part: number;
  total: number;
  selected: boolean;
}

export interface QuotationComparison {
  request: QuotationRequestRow;
  settings: { weights: { price: number; reliability: number; delivery: number }; min_quotes: number; stale_quote_days: number };
  today: string;
  stats: {
    count: number;
    lowest: number | null;
    highest: number | null;
    average: number | null;
    spread: number | null;
    spread_pct: number | null;
    lowest_per_part: number | null;
    highest_per_part: number | null;
    average_per_part: number | null;
  };
  quotes: ComparedQuote[];
  withdrawn: Array<{ id: string; vendor_name: string; quote_date: string; basis: string; price: number; withdrawn_reason: string }>;
  recommendation: {
    quotation_id: string | null;
    available: boolean;
    reason: string | null;
    weights_used: { price: number; reliability: number; delivery: number };
    left_out: string[];
    note: string;
  };
  history: { part: PartHistoryRow[]; part_quotes: QuoteHistoryRow[]; category: PartHistoryRow[] };
}
