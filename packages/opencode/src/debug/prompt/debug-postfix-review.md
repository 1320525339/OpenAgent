---
name: debug-postfix-review
description: Use after a bug fix to review whether the patch is minimal, reusable, maintainable, efficient, and adequately verified before reporting completion.
---

# Debug Postfix Review

Use this skill after applying a bug fix and before the final report.

## Review Inputs

Collect these inputs first:

- Original bug report or failing behavior.
- Reproduction command or interaction.
- Changed files.
- Debug artifact directory or trace id, when available.
- Verification commands already run.

## Review Passes

### Code Reuse

- Search for existing utilities, schemas, services, or patterns that should have been reused.
- Check whether the fix duplicates nearby logic or creates a second way to do the same thing.
- Prefer the local codebase pattern over a new abstraction.
- Do not request a helper for a single simple expression.

### Code Quality

- Check that the patch fixes the confirmed root cause, not only the symptom.
- Look for unnecessary state, broad guards, silent fallbacks, swallowed errors, or stringly typed behavior.
- Confirm the changed code keeps the original ownership boundary intact.
- Check whether the final code is easier to reason about than the failing path.

### Efficiency And Concurrency

- Look for repeated work on hot paths, overly broad scans, unnecessary file reads, or avoidable sequential operations.
- Check for races, lost updates, stale state, cleanup gaps, and lifecycle leaks.
- Prefer parallel reads or independent checks when they do not share state.
- Verify temporary instrumentation was cleaned up or scoped.

### Verification Coverage

- Confirm the original reproduction was rerun after the fix.
- Confirm adjacent flows sharing the same boundary were checked.
- For non-trivial fixes, confirm independent QA was run or explain why it was not needed.
- Classify the result as PASS, FAIL, or PARTIAL.

## Output Format

Return a compact review:

- Verdict: PASS, FAIL, or PARTIAL.
- Root cause coverage: whether the patch addresses the confirmed cause.
- Reuse/quality findings: only actionable findings, with file paths and line references when possible.
- Efficiency/concurrency findings: only actionable findings.
- Verification: commands or interactions run, plus any missing checks.
- Required follow-up: smallest next action if the review is not PASS.
