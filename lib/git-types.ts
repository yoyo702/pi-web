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
}

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
