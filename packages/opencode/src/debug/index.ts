import path from "path"
import { ulid } from "ulid"
import { Effect, Layer, Context } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"

export type Mode = "minimal" | "trace" | "invasive"

export type SessionInfo = {
  id: string
  mode: Mode
  startedAt: number
  outputDir: string
  bugType?: string
  scope: string[]
  capture: {
    tools: boolean
    mcp: boolean
    stacks: boolean
    subagents: boolean
  }
}

export type Report = {
  session: Record<string, unknown> | undefined
  outputDir: string
  eventCount: number
  errorCount: number
  stackCount: number
  components: string[]
  recentEvents: EventRecord[]
  errors: ErrorRecord[]
  stacks: StackRecord[]
}

type EventRecord = {
  ts: number
  traceId: string
  component: string
  event: string
  data?: Record<string, unknown>
}

type StackRecord = EventRecord & {
  stack: string
}

type ErrorRecord = EventRecord & {
  message: string
  stack?: string
}

type State = {
  session: SessionInfo | undefined
}

const sharedState: State = { session: undefined }

export interface Interface {
  readonly current: () => Effect.Effect<SessionInfo | undefined>
  readonly bootstrap: (input: {
    mode: Mode
    bugType?: string
    scope?: string[]
    capture?: Partial<SessionInfo["capture"]>
  }) => Effect.Effect<SessionInfo>
  readonly event: (input: { component: string; event: string; data?: Record<string, unknown> }) => Effect.Effect<void>
  readonly stack: (input: { component: string; event: string; data?: Record<string, unknown> }) => Effect.Effect<void>
  readonly error: (input: {
    component: string
    event: string
    error: unknown
    data?: Record<string, unknown>
  }) => Effect.Effect<void>
  readonly report: (input?: { outputDir?: string; limit?: number }) => Effect.Effect<Report>
  readonly cleanup: (input?: { reason?: string }) => Effect.Effect<SessionInfo | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Debug") {}

function stringifyError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    message: String(error),
    stack: undefined,
  }
}

function lines(input: unknown) {
  return JSON.stringify(input) + "\n"
}

function parseJsonRecord(input: string | undefined) {
  if (!input) return undefined
  try {
    const parsed = JSON.parse(input)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>
    return undefined
  } catch {
    return undefined
  }
}

function parseNdjson<T>(input: string | undefined) {
  if (!input) return []
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const append = Effect.fnUntraced(function* (name: string, payload: unknown) {
      if (!sharedState.session) return
      const file = path.join(sharedState.session.outputDir, name)
      const existing = (yield* fs.readFileStringSafe(file)) ?? ""
      yield* fs.writeWithDirs(file, existing + lines(payload))
    })

    const current = Effect.fn("Debug.current")(function* () {
      return sharedState.session
    })

    const bootstrap = Effect.fn("Debug.bootstrap")(function* (input: {
      mode: Mode
      bugType?: string
      scope?: string[]
      capture?: Partial<SessionInfo["capture"]>
    }) {
      const ctx = yield* InstanceState.context
      const startedAt = Date.now()
      const id = `dbg_${startedAt}_${ulid().toLowerCase()}`
      const outputDir = path.join(ctx.worktree, ".opencode", "debug", id)
      const session: SessionInfo = {
        id,
        mode: input.mode,
        startedAt,
        outputDir,
        bugType: input.bugType,
        scope: input.scope?.length ? input.scope : ["session", "tool", "mcp"],
        capture: {
          tools: input.capture?.tools ?? true,
          mcp: input.capture?.mcp ?? true,
          stacks: input.capture?.stacks ?? input.mode !== "minimal",
          subagents: input.capture?.subagents ?? true,
        },
      }
      sharedState.session = session
      yield* fs.ensureDir(outputDir)
      yield* fs.writeFileString(
        path.join(outputDir, "summary.json"),
        JSON.stringify(
          {
            traceId: session.id,
            mode: session.mode,
            bugType: session.bugType,
            scope: session.scope,
            capture: session.capture,
            startedAt: session.startedAt,
            workspace: ctx.worktree,
            directory: ctx.directory,
          },
          null,
          2,
        ),
      )
      yield* append("timeline.ndjson", {
        ts: startedAt,
        traceId: session.id,
        component: "debug",
        event: "bootstrap",
        data: {
          mode: session.mode,
          bugType: session.bugType,
          scope: session.scope,
          capture: session.capture,
        },
      } satisfies EventRecord)
      return session
    })

    const event = Effect.fn("Debug.event")(function* (input: {
      component: string
      event: string
      data?: Record<string, unknown>
    }) {
      const session = yield* current()
      if (!session) return
      yield* append("timeline.ndjson", {
        ts: Date.now(),
        traceId: session.id,
        component: input.component,
        event: input.event,
        data: input.data,
      } satisfies EventRecord)
    })

    const stack = Effect.fn("Debug.stack")(function* (input: {
      component: string
      event: string
      data?: Record<string, unknown>
    }) {
      const session = yield* current()
      if (!session || !session.capture.stacks) return
      yield* append("stacks.ndjson", {
        ts: Date.now(),
        traceId: session.id,
        component: input.component,
        event: input.event,
        data: input.data,
        stack: new Error(`${input.component}:${input.event}`).stack ?? "",
      } satisfies StackRecord)
    })

    const error = Effect.fn("Debug.error")(function* (input: {
      component: string
      event: string
      error: unknown
      data?: Record<string, unknown>
    }) {
      const session = yield* current()
      if (!session) return
      const normalized = stringifyError(input.error)
      yield* append("errors.ndjson", {
        ts: Date.now(),
        traceId: session.id,
        component: input.component,
        event: input.event,
        data: input.data,
        message: normalized.message,
        stack: normalized.stack,
      } satisfies ErrorRecord)
    })

    const report = Effect.fn("Debug.report")(function* (input?: { outputDir?: string; limit?: number }) {
      const session = yield* current()
      const outputDir = input?.outputDir ?? session?.outputDir
      if (!outputDir) throw new Error("No active debug session. Pass output_dir to inspect an existing debug run.")

      const limit = Math.max(1, Math.min(input?.limit ?? 20, 200))
      const summary = parseJsonRecord(yield* fs.readFileStringSafe(path.join(outputDir, "summary.json")))
      const events = parseNdjson<EventRecord>(yield* fs.readFileStringSafe(path.join(outputDir, "timeline.ndjson")))
      const errors = parseNdjson<ErrorRecord>(yield* fs.readFileStringSafe(path.join(outputDir, "errors.ndjson")))
      const stacks = parseNdjson<StackRecord>(yield* fs.readFileStringSafe(path.join(outputDir, "stacks.ndjson")))
      return {
        session: summary,
        outputDir,
        eventCount: events.length,
        errorCount: errors.length,
        stackCount: stacks.length,
        components: [...new Set(events.map((event) => event.component))].toSorted(),
        recentEvents: events.slice(-limit),
        errors: errors.slice(-limit),
        stacks: stacks.slice(-limit),
      } satisfies Report
    })

    const cleanup = Effect.fn("Debug.cleanup")(function* (input?: { reason?: string }) {
      const session = yield* current()
      if (!session) return undefined
      yield* append("timeline.ndjson", {
        ts: Date.now(),
        traceId: session.id,
        component: "debug",
        event: "cleanup",
        data: {
          reason: input?.reason,
        },
      } satisfies EventRecord)
      sharedState.session = undefined
      return session
    })

    return Service.of({
      current,
      bootstrap: (input) => bootstrap(input).pipe(Effect.orDie),
      event: (input) => event(input).pipe(Effect.orDie),
      stack: (input) => stack(input).pipe(Effect.orDie),
      error: (input) => error(input).pipe(Effect.orDie),
      report: (input) => report(input).pipe(Effect.orDie),
      cleanup: (input) => cleanup(input).pipe(Effect.orDie),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as Debug from "./index"
