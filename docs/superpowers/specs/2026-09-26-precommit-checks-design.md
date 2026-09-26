# Git Review pre-commit checks

## Goal

Before committing in Git Review, show optional hints about the staged changes. The checks never block a commit.

## UI

`components/PrecommitChecks.tsx` sits above the commit message box in the Changes tab:

- A "Pre-commit checks" header, collapsed by default. The open state is kept in localStorage (`pi-web:precommit-checks-open`).
- The header shows the number of notes: local findings, open-work reminders, and the issues of a review that is still current.
- The Commit button never depends on the checks.

It has three groups.

**Staged changes.** Local, rule-based findings:

- Clicking one selects that file's staged diff.
- The checks run again whenever Git status is reloaded and something is staged.

**Open work.** Reminders about unfinished work in the repository (a cwd equal to or inside the repository root):

- Project tasks ("Task: <script>" terminals) that are still running.
- Tasks whose latest run exited non-zero.
- Claude and Codex terminals whose activity is working or approval.
- Codex and Claude chat runtimes that are running or waiting for approval.
- A terminal or chat matches when its cwd is inside the repository under either spelling: Git's real path or the workspace path (they differ through symlinks).
- The data comes from the live workspace status stream. Pi chat sessions are not included, because the running-session list has no cwd.

**AI review.** Only runs when the user clicks "Review with AI":

- Shows a summary, up to 5 possible issues (with file paths), and the provider/model used.
- When the staged fingerprint from the latest precheck differs from the review's, the review is dimmed and marked "Staged changes changed since this review."
- When the local checks found possible secrets, the user confirms before the diff is sent to the model.
- Switching repositories drops the review, including one still running. A failed precheck clears the old findings and fingerprint.

## Server

`GET /api/git/precheck?cwd=` → `getGitPrecheck` (lib/git-precheck.ts):

- When the workspace is a subfolder of the repository, every diff (raw, scan and review) is limited to it with a `:(top,literal)<prefix>` pathspec, matching the files Git Review lists.

- `stagedFingerprint` is the sha256 of `git diff --cached --raw -z --no-abbrev --no-renames`.
- It scans the added lines of `git diff --cached --unified=0 --no-renames`. The diff uses fixed `a/`/`b/` prefixes, `--no-textconv`, and `core.quotePath=false`. Header paths are C-unquoted (octal bytes and `\t`-style escapes), and the tab git adds after a name with a space is dropped.
- The first rule that matches a line wins:
  - conflict markers: `<<<<<<<` / `>>>>>>>`, and `=======` only after a `<<<<<<<` in the same file;
  - secrets: private key headers, AWS access keys, GitHub tokens, Slack tokens, `sk-…` keys. These are reported without their text;
  - debug statements: `console.log/debug/trace(`, `debugger`, `breakpoint()`, `pdb.set_trace()`;
  - new TODO / FIXME / XXX.
- Staged blobs of 1 MiB or more are reported as large files. Sizes come from one `git cat-file --batch-check=%(objectsize)`. Deleted files, submodules and unmerged entries (all-zero ids during a conflicted merge) are skipped.
- At most 200 findings. A diff larger than 8 MiB is scanned as far as it was read. In either case `truncated` is set.

`POST /api/git/review {cwd}`:

- The staged diff (`--unified=3`, fixed prefixes) is cut to 50,000 characters.
- It is sent between random `BEGIN DIFF-…`/`END DIFF-…` lines, with a prompt that treats the diff as untrusted data and asks for `{summary, issues:[{path, note}]}` JSON.
- The call goes through `completeWithDefaultModel` (lib/pi-default-model.ts, now also used by commit-message generation): the Pi default model, a 30 s timeout, no retries.
- An answer that is not valid JSON becomes the summary.
- Errors:
  - nothing staged: 400;
  - no default model or API key: 400;
  - model error or timeout: 502.

## Tests

- `lib/git-precheck.test.mjs`:
  - scanning rules and line numbers;
  - a `+++ ` added line and Markdown underlines are not misread;
  - secrets carry no text;
  - the findings limit;
  - raw diff parsing with renames;
  - a temp repo with a large file, unstaged files ignored, and `diff.noprefix` set;
  - quoted paths and paths with spaces;
  - a conflicted merge (unmerged entries);
  - a subfolder workspace;
  - fingerprint changes;
  - reviews need staged changes;
  - the prompt treats the diff as untrusted data;
  - lenient parsing of the model's answer.
- `lib/open-work-reminders.test.mjs`: latest task run, failed / running tasks, agent activity, chat runtimes, and cwd matching under either spelling of the repository folder.
- e2e (`e2e/app-shell.spec.ts`), with mocked APIs:
  - collapsed badge;
  - Commit stays enabled;
  - a finding opens the diff;
  - the AI review adds its issues;
  - a changed fingerprint marks the review stale.
