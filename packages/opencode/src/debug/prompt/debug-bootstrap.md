---
name: debug-bootstrap
description: Use when a bug investigation needs temporary instrumentation, structured logs, timeline traces, or boundary stack snapshots inside opencode itself. Load this before adding ad hoc logging so diagnostics stay scoped and analyzable.
---

# Debug Bootstrap

Use this skill when the task is to investigate, reproduce, or fix a bug in opencode itself and you need more runtime evidence than a plain test failure or stack trace provides.

## Workflow

1. Reproduce the failure path or determine the closest runnable entrypoint.
2. Call the `debug_bootstrap` tool before adding custom logs.
3. Choose the least invasive mode that can answer the question:
   - `minimal`: timeline events and error stacks
   - `trace`: add tool, MCP, and agent resolution events
   - `invasive`: capture extra boundary stacks and denser event streams for a narrow scope
4. Run the reproduction command or interaction.
5. Call `debug_report` to summarize the generated debug artifacts before editing code.
6. Apply the smallest fix that follows from the evidence.
7. Validate the original failure path and adjacent paths.
8. Call `debug_cleanup` once validation is complete.

## Evidence Collection

- Start with the smallest artifact slice that can answer the question.
- Read the tail of large logs first, then search the full artifact for error and warning markers.
- Search full debug artifacts for normalized failures before reading large files end to end.
- If debug logging was just enabled and the report has no useful events yet, reproduce the issue again before drawing conclusions.
- Preserve the reproduction command, selected mode, trace id, and artifact directory in your notes so a verifier can repeat the investigation.
- Prefer structured debug artifacts over ad hoc logging. If temporary custom logs are unavoidable, keep them narrow and remove them before the final fix.

## Rules

- Prefer built-in debug instrumentation over scattered `console.log` calls.
- Capture stacks only at boundaries, failures, timeouts, and suspicious state transitions.
- Keep debug sessions scoped to the current workspace and current bug.
- Do not leave invasive tracing enabled after the fix is verified.
- Do not assume a missing stack means no failure occurred; check whether the failing boundary is instrumented.
- Do not treat timestamps alone as ordering proof when `sessionID`, `messageID`, `tool`, `agent`, or `traceId` are available.

## Expected Artifacts

- `summary.json`: bootstrap config and session metadata
- `timeline.ndjson`: ordered runtime events
- `stacks.ndjson`: captured stack snapshots
- `errors.ndjson`: normalized failures and thrown errors
- `debug_report`: tool-generated summary of recent timeline events, errors, stack captures, and component coverage

## Analysis Guidance

- Start with timeline ordering to find the failing phase.
- Use stacks to locate the exact boundary that triggered the bad path.
- Correlate `sessionID`, `messageID`, `tool`, `agent`, and `traceId` instead of reasoning from timestamps alone.
- Treat missing events as evidence too: if the expected component never appears in `debug_report`, inspect the boundary before it.
- Compare the first bad event with the last known-good boundary; the bug is usually between those two points.
- Separate observations from hypotheses in the report. Mark uncertain explanations as hypotheses until code or runtime evidence confirms them.

## Verification Guidance

- A fix is not complete until the original failure path has been rerun.
- For non-trivial fixes, run a clean verification pass that starts from the bug report and changed files, not from the implementation narrative alone.
- Use PASS only when the reproduction and relevant adjacent checks succeed.
- Use FAIL when any required check still fails, and include the failing command or interaction.
- Use PARTIAL when the environment prevents verification, and name the missing prerequisite.
