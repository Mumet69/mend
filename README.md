# mend

One patch tool for every AI edit format. `mend` applies an edit that an
AI model wrote to a tree of text files, in any of four formats: unified
diff, SEARCH/REPLACE blocks, V4A patches, or JSON text-editor tool calls.
Every file is changed or nothing is.

![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mumet69/mend/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mumet69/mend/reward.svg)

Bounty: https://make.fun/bounty/hidden-spec-cli-01-run-20261122

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file; when absent or `-`, the patch is
  read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a`, `json`, or `auto` (the default, which detects
  the format).
- `--check` does everything but write: same output and exit code, no file
  is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Edits that do not match exactly are found with three tiers of fuzzy
matching: exact lines, lines equal after trailing whitespace is removed,
then lines equal after leading and trailing whitespace is removed (with
re-indentation of the new lines). A failed edit is reported and the
edits after it still run; when any edit failed, no file is written.

## Exit codes

- `0` — the tree is written; changed paths are listed, then
  `ok: <n> files`.
- `1` — one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`; no file is written.
- `2` — one line: `error: usage`, `error: no-patch`, `error: format`,
  or `error: parse <N>`; nothing is written.
