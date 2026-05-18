import { Effect, Schema } from "effect"
import { Debug } from "@/debug"
import * as Tool from "./tool"

const Mode = Schema.Literals(["minimal", "trace", "invasive"]).annotate({
  description: "Diagnostics depth. Prefer minimal unless the bug needs denser runtime evidence.",
})

export const Parameters = Schema.Struct({
  mode: Mode,
  bug_type: Schema.optional(Schema.String).annotate({
    description: "Short label for the bug category being investigated.",
  }),
  scope: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Subsystems to emphasize, such as session, tool, mcp, agent, desktop, or llm.",
  }),
  capture_tools: Schema.optional(Schema.Boolean),
  capture_mcp: Schema.optional(Schema.Boolean),
  capture_stacks: Schema.optional(Schema.Boolean),
  capture_subagents: Schema.optional(Schema.Boolean),
})

type Metadata = {
  traceId: string
  outputDir: string
  mode: string
}

export const DebugBootstrapTool = Tool.define<typeof Parameters, Metadata, Debug.Service>(
  "debug_bootstrap",
  Effect.gen(function* () {
    const debug = yield* Debug.Service

    return {
      description:
        "Initialize scoped debug instrumentation for opencode itself. This creates a debug session with structured logs, timeline traces, and optional boundary stack snapshots under .opencode/debug/.",
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const session = yield* debug.bootstrap({
            mode: params.mode,
            bugType: params.bug_type,
            scope: params.scope ? [...params.scope] : undefined,
            capture: {
              tools: params.capture_tools,
              mcp: params.capture_mcp,
              stacks: params.capture_stacks,
              subagents: params.capture_subagents,
            },
          })
          return {
            title: "Debug instrumentation enabled",
            output: [
              `Debug session initialized.`,
              `Trace ID: ${session.id}`,
              `Mode: ${session.mode}`,
              `Output directory: ${session.outputDir}`,
              `Scope: ${session.scope.join(", ")}`,
              `Next step: reproduce the bug and inspect summary.json, timeline.ndjson, errors.ndjson, and stacks.ndjson.`,
            ].join("\n"),
            metadata: {
              traceId: session.id,
              outputDir: session.outputDir,
              mode: session.mode,
            },
          }
        }),
    }
  }),
)
