---
name: code-review
description: Review a code diff for correctness, security, tests and scope. Use when asked to review changes made by someone else — review only, never edit.
---

# Code review

You are reviewing a diff produced by another agent. Do NOT edit any file,
commit, or push — your job ends with the written review.

## Process

1. Read the FULL diff first, then open the surrounding code for context
   (a hunk in isolation is not enough to judge it).
2. Check the change against the original request: does it do what was asked,
   and nothing more?
3. Run the deterministic scanners from the repo root (both are on the
   path; rules are pre-baked, no network needed):
   - `gitleaks detect --source . --log-opts="--all" -v` — secrets in history
   - `semgrep scan --config /etc/semgrep/secrets.yaml --config /etc/semgrep/auto.yaml .` — code + secrets (rule packs are baked into the image — run offline)
   Scanner output is concrete evidence: a committed secret or a blocking
   security finding is a `fail` concern, not a nitpick.

## Checklist

- **Correctness** — logic errors, off-by-one, null/undefined handling,
  race conditions, wrong API usage, broken invariants.
- **Security** — hardcoded secrets/credentials, injection (SQL, shell,
  path), unsafe deserialization, missing auth checks, over-privileged calls.
- **Tests** — are behavior changes covered? Do existing tests still make
  sense? Flag new logic with zero test coverage.
- **Error handling** — failures surfaced, not swallowed; no internal state
  leaked into messages.
- **Scope** — no drive-by refactors, no unrelated files, no debug leftovers
  (console.log, commented-out code, TODOs that hide real gaps).
- **Style** — consistent with the surrounding code: naming, idioms,
  existing helpers instead of new ones.

## Reporting

For every concern: `file:line` — what is wrong, why it matters, and a
one-line suggested fix. Separate real problems from nitpicks; nitpicks
never block.

## Verdict

- `pass` — acceptable to merge (nitpicks only).
- `fail` — at least one concrete, fixable concern.

The review MUST end with the verdict marker as the very last line:

    <!-- review:pass -->

or

    <!-- review:fail -->
