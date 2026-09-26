# Git Review line-level stage / unstage / discard

## Goal

In Git Review, stage, unstage, or discard single hunks or selected lines instead of whole files.

## Scope

| Group | Actions |
|---|---|
| Changes (unstaged) | Stage, Discard (with confirmation) |
| Staged | Unstage |
| Untracked | Stage (only the selected lines are staged; the working copy is not changed) |

Renamed files, combined diffs and text that is not UTF-8 keep whole-file actions only.

## Design

- `getGitFileDiff` adds `fingerprint` (the sha256 of the patch) when line actions are possible. The diff is always generated with `a/` / `b/` prefixes and without textconv, whatever the user's git config.
- The browser sends `POST /api/git/lines` with `{cwd, path, scope, action, fingerprint, lineIds}`. Line ids number the changed (`+`/`-`) lines across the whole patch.
- The server regenerates the diff, compares fingerprints, and returns 409 if they differ. It then builds the partial patch itself (`lib/git-partial-patch.ts`):
  - Forward (stage): an unselected `+` line is dropped, and an unselected `-` line becomes context.
  - Reverse (unstage, discard): an unselected `+` line becomes context, and an unselected `-` line is dropped.
  - Hunk starts keep the side that `git apply` reads, and shift the other side by the running delta.
  - Partial patches drop the `index` line and any `old mode` / `new mode` change. A `new file mode` / `deleted file mode` line is kept only while that side stays `/dev/null`. Otherwise both sides name the file.
  - A line without a final newline that is no longer last on the written side gets a newline there; a context line is split into its read-side half and a written half, as `git add -p` does.
- Line ids outside the diff return 400.
- The patch is applied from a temp file:
  - stage: `git apply --cached`
  - unstage: `git apply --cached -R`
  - discard: `git apply -R`
- A failed apply or a busy index (`index.lock`) returns 409.
- An untracked file is staged by writing the selected added lines as a blob with `hash-object -w`, then `update-index --add --cacheinfo`. The file mode follows the executable bit.

## UI

`components/GitLineDiffView.tsx`:

- Each hunk header has "Stage hunk", "Discard hunk" and "Unstage hunk" buttons.
- The gutter checkbox on each changed line selects it. Shift+click selects a range, and dragging also selects.
- A sticky toolbar shows "N lines selected" with the actions and Clear.
- After any write, the diff reloads in place without a loading flash. The view is keyed by fingerprint, so the selection resets only when the diff actually changed.
- The selection closes when the file leaves its group.

## Tests

- `lib/git-partial-patch.test.mjs`: exact patches, plus random stage / discard / unstage selections (with and without final newlines) checked against real `git apply` in a temp repo.
- `lib/git-line-staging.test.mjs`: stage, unstage and discard lines; a partial untracked file (including the exec bit); partial deletions; a stale fingerprint returning 409; invalid scope and action combinations; out-of-range line ids; mode changes left out; `diff.noprefix` config; no fingerprint for renames, combined diffs or non-UTF-8 text.
- e2e (`e2e/app-shell.spec.ts`): select, Shift+click and deselect lines; cancel the discard confirmation; check the stage request payload; reload the diff; stage a hunk.
