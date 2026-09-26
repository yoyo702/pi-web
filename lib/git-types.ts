export type GitFileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict";

export interface GitFileStatus {
  filePath: string;
  status: GitFileStatusKind;
  code: "M" | "A" | "D" | "R" | "U" | "C";
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatusResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  branch: string | null;
  files: GitFileStatus[];
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
  remotes?: string[];
}

export interface GitStashEntry {
  index: number;
  ref: string;
  message: string;
  date: string;
}
export interface GitCommitSummary {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  parents: string[];
  refs: string[];
  subject: string;
}

export interface GitLogResponse {
  isGitRepository: boolean;
  commits: GitCommitSummary[];
  hasMore: boolean;
}

export interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: GitFileStatusKind;
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
  refs: string[];
  subject: string;
  body: string;
  files: GitCommitFile[];
  additions: number;
  deletions: number;
}

export type GitDiffScope = "combined" | "staged" | "unstaged" | "untracked";

export interface GitFileDiffResponse {
  supported: boolean;
  status?: GitFileStatusKind;
  scope?: GitDiffScope;
  patch?: string;
  /**
   * Set when single hunks or lines of this diff can be staged, unstaged or
   * discarded; sent back with the request so a diff that changed meanwhile
   * is refused.
   */
  fingerprint?: string;
}

export type GitLineAction = "stage" | "unstage" | "discard";

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  subject: string;
  lastCommitDate: string | null;
}

export interface GitBranchesResponse {
  isGitRepository: boolean;
  current: string | null;
  local: GitBranch[];
  remotes: GitBranch[];
}

export type GitPrecheckKind = "conflict-marker" | "debug" | "todo" | "secret" | "large-file";

/** A hint about the staged changes; never blocks a commit. */
export interface GitPrecheckFinding {
  kind: GitPrecheckKind;
  /** Repository-relative path with `/` separators. */
  path: string;
  /** New-side line number, for line findings. */
  line?: number;
  /** The added line, trimmed and shortened; never set for secrets. */
  text?: string;
  message: string;
}

export interface GitPrecheckResponse {
  /** Changes whenever the staged changes do. */
  stagedFingerprint: string;
  findings: GitPrecheckFinding[];
  /** Some findings or some of the diff were left out. */
  truncated: boolean;
}

export interface GitAiReviewIssue {
  path: string | null;
  note: string;
}

export interface GitAiReviewResponse {
  summary: string;
  issues: GitAiReviewIssue[];
  stagedFingerprint: string;
  provider: string;
  modelId: string;
  truncated: boolean;
}
