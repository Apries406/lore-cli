import type {
  CaptureAction,
  CaptureCandidateStatus,
  CaptureMode,
  SensitiveContentKind,
} from "./enums.js";

export interface CaptureRule {
  id: string;
  action: CaptureAction;
  description: string;
  categories?: string[];
  path_patterns?: string[];
  keywords?: string[];
  repository_patterns?: string[];
}

export interface CapturePolicy {
  version: 1;
  mode: CaptureMode;
  default_action: CaptureAction;
  confirmation_below: number;
  automatic_accept_above: number;
  auto_apply: boolean;
  rules: CaptureRule[];
}

export interface CaptureOrigin {
  kind: "git_diff" | "task_summary" | "explicit";
  repository?: string;
  revision?: string;
  changed_paths: string[];
}

export interface CaptureCandidateDraft {
  version: 1;
  title: string;
  summary: string;
  details: string;
  category: string;
  confidence: number;
  tags: string[];
  questions: string[];
  origin: CaptureOrigin;
}

export interface CaptureCandidate extends CaptureCandidateDraft {
  candidate_id: string;
  dedupe_key: string;
  status: CaptureCandidateStatus;
  decision: CaptureAction;
  matched_rules: string[];
  created_at: string;
  updated_at: string;
  source_id?: string;
  snapshot_id?: string;
  compile_run_id?: string;
  rejection_reason?: string;
}

export interface CaptureProposalResult {
  stored: boolean;
  decision: CaptureAction;
  matched_rules: string[];
  sensitive: boolean;
  sensitive_kinds?: SensitiveContentKind[];
  deduplicated: boolean;
  auto_accept: boolean;
  candidate?: CaptureCandidate;
}

export interface CaptureTaskPacket {
  version: 1;
  should_review: boolean;
  repository: string;
  revision?: string;
  changed_paths: string[];
  eligible_paths: string[];
  excluded_paths: string[];
  task_summary: string;
  diff: string;
  truncated: boolean;
}
