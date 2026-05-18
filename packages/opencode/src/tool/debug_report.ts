import { Effect, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Debug } from "@/debug"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  output_dir: Schema.optional(Schema.String).annotate({
    description: "Existing .opencode/debug/<trace-id> directory to inspect. Defaults to the active debug session.",
  }),
  limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum recent events, errors, and stacks to include. Defaults to 20.",
  }),
})

type Metadata = {
  outputDir: string
  eventCount: number
  errorCount: number
  stackCount: number
}

function formatValue(value: unknown) {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function formatEvent(input: { ts: number; component: string; event: string; data?: Record<string, unknown> }) {
  const data = formatValue(input.data)
  return `- ${new Date(input.ts).toISOString()} ${input.component}/${input.event}${data ? ` ${data}` : ""}`
}

export const DebugReportTool = Tool.define<typeof Parameters, Metadata, Debug.Service>(
  "debug_report",
  Effect.gen(function* () {
    const debug = yield* Debug.Service

    return {
      description:
        "Summarize an active or existing opencode debug session. Use this after reproducing a bug to inspect timeline events, normalized errors, and boundary stack captures before editing code.",
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const current = yield* debug.current()
          if (!params.output_dir && !current) {
            return {
              title: "Debug report unavailable",
              output: "No active debug session is currently running. Call debug_bootstrap first or pass output_dir.",
              metadata: {
                outputDir: "",
                eventCount: 0,
                errorCount: 0,
                stackCount: 0,
              },
            }
          }
          const report = yield* debug.report({
            outputDir: params.output_dir,
            limit: params.limit,
          })
          return {
            title: "Debug report",
            output: [
              `Debug report: ${report.outputDir}`,
              `Events: ${report.eventCount}`,
              `Errors: ${report.errorCount}`,
              `Stacks: ${report.stackCount}`,
              `Components: ${report.components.length ? report.components.join(", ") : "(none)"}`,
              "",
              "Recent events:",
              report.recentEvents.length ? report.recentEvents.map(formatEvent).join("\n") : "- none",
              "",
              "Errors:",
              report.errors.length
                ? report.errors
                    .map((error) =>
                      [
                        formatEvent(error),
                        error.message ? `  message: ${error.message}` : undefined,
                        error.stack ? `  stack: ${error.stack.split(/\r?\n/).slice(0, 6).join("\n  ")}` : undefined,
                      ]
                        .filter(Boolean)
                        .join("\n"),
                    )
                    .join("\n")
                : "- none",
              "",
              "Stack captures:",
              report.stacks.length
                ? report.stacks
                    .map((stack) =>
                      [
                        formatEvent(stack),
                        stack.stack ? `  stack: ${stack.stack.split(/\r?\n/).slice(0, 6).join("\n  ")}` : undefined,
                      ]
                        .filter(Boolean)
                        .join("\n"),
                    )
                    .join("\n")
                : "- none",
            ].join("\n"),
            metadata: {
              outputDir: report.outputDir,
              eventCount: report.eventCount,
              errorCount: report.errorCount,
              stackCount: report.stackCount,
            },
          }
        }),
    }
  }),
)
