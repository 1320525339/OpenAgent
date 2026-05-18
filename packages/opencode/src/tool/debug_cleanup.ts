import { Effect, Schema } from "effect"
import { Debug } from "@/debug"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  reason: Schema.optional(Schema.String).annotate({
    description: "Short reason for closing the active debug session.",
  }),
})

type Metadata = {
  traceId?: string
  outputDir?: string
  closed: boolean
}

export const DebugCleanupTool = Tool.define<typeof Parameters, Metadata, Debug.Service>(
  "debug_cleanup",
  Effect.gen(function* () {
    const debug = yield* Debug.Service

    return {
      description:
        "Close the active opencode debug instrumentation session after the fix and validation are complete. This stops additional timeline, error, and stack capture for the current process.",
      parameters: Parameters,
      execute: (params) =>
        Effect.gen(function* () {
          const session = yield* debug.cleanup({ reason: params.reason })
          if (!session) {
            return {
              title: "Debug instrumentation inactive",
              output: "No active debug session is currently running.",
              metadata: {
                closed: false,
              },
            }
          }
          return {
            title: "Debug instrumentation closed",
            output: [`Debug session closed.`, `Trace ID: ${session.id}`, `Output directory: ${session.outputDir}`].join(
              "\n",
            ),
            metadata: {
              traceId: session.id,
              outputDir: session.outputDir,
              closed: true,
            },
          }
        }),
    }
  }),
)
