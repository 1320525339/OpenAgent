import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_ASK from "./prompt/ask.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_DEBUG from "./prompt/debug.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SCOUT from "./prompt/scout.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_VERIFICATION from "./prompt/verification.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { type DeepMutable } from "@opencode-ai/core/schema"

const PermissionMode = Schema.Literals(["inherit", "build", "ask", "plan", "general", "explore", "scout"])
type PermissionMode = Schema.Schema.Type<typeof PermissionMode>

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  disallowedTools: Schema.optional(Schema.Array(Schema.String)),
  skills: Schema.optional(Schema.Array(Schema.String)),
  permissionMode: Schema.optional(PermissionMode),
  background: Schema.optional(Schema.Boolean),
  memoryScope: Schema.optional(Schema.String),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.ModelNotFoundError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export function allowsTool(agent: Pick<Info, "allowedTools" | "disallowedTools">, toolID: string) {
  if (agent.allowedTools?.length && !agent.allowedTools.includes(toolID)) return false
  return !agent.disallowedTools?.includes(toolID)
}

export function allowsSkill(agent: Pick<Info, "skills">, skillName: string) {
  if (!agent.skills?.length) return true
  return agent.skills.includes(skillName)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          repo_clone: "deny",
          repo_overview: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "默认代理。根据当前配置的权限执行工具和任务。",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_enter: "allow",
                ask_enter: "allow",
                bash: {
                  "rm -rf /*": "deny",
                  "rm -rf ~*": "deny",
                  "sudo rm -rf /*": "deny",
                  "sudo rm -rf ~*": "deny",
                  "* > /dev/sd*": "deny",
                  "dd if=* of=/dev/sd*": "deny",
                  "mkfs.*": "deny",
                  ":(){ :|:& };:*": "deny",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
            permissionMode: "build",
          },
          ask: {
            name: "ask",
            description: "问答模式。提供有依据、可验证的答案，不修改文件。",
            options: {
              omitInstructions: true,
            },
            permission: Permission.merge(
              defaults,
              user,
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                grep: "allow",
                glob: "allow",
                webfetch: "allow",
                websearch: "allow",
                question: "allow",
                external_directory: readonlyExternalDirectory,
              }),
            ),
            prompt: PROMPT_ASK,
            mode: "primary",
            native: true,
            permissionMode: "ask",
          },
          plan: {
            name: "plan",
            description: "规划模式。禁止所有编辑类工具，只负责分析和制定计划。",
            options: {},
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                plan_exit: "allow",
                external_directory: {
                  [path.join(Global.Path.data, "plans", "*")]: "allow",
                },
                edit: {
                  "*": "deny",
                  [path.join(".opencode", "plans", "*.md")]: "allow",
                  [path.relative(ctx.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
                },
              }),
              user,
            ),
            mode: "primary",
            native: true,
            permissionMode: "plan",
          },
          general: {
            name: "general",
            description: `通用子代理。适合研究复杂问题和执行多步骤任务，也适合并行处理多个独立工作单元。`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
            permissionMode: "general",
          },
          verification: {
            name: "verification",
            description:
              "只读验证子代理。用于在报告完成前运行构建、测试、运行时检查和对抗性验证。",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                bash: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                webfetch: "allow",
                websearch: "allow",
                skill: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            prompt: PROMPT_VERIFICATION,
            options: {},
            mode: "subagent",
            native: true,
            background: true,
            allowedTools: ["read", "glob", "grep", "bash", "skill", "webfetch", "websearch"],
            permissionMode: "explore",
            memoryScope: "project",
          },
          debug: {
            name: "debug",
            description:
              "Bug 修复专用代理。负责调查项目缺陷、定位根因、应用最小补丁并验证修复结果。",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                question: "allow",
                skill: "allow",
                bash: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                edit: "allow",
                write: "allow",
                patch: "allow",
                webfetch: "allow",
                websearch: "allow",
                debug_bootstrap: "allow",
                debug_report: "allow",
                debug_cleanup: "allow",
              }),
              user,
            ),
            options: {},
            mode: "primary",
            native: true,
            prompt: PROMPT_DEBUG,
            allowedTools: [
              "read",
              "glob",
              "grep",
              "bash",
              "edit",
              "write",
              "apply_patch",
              "task",
              "skill",
              "debug_bootstrap",
              "debug_report",
              "debug_cleanup",
            ],
            skills: ["debug-bootstrap", "debug-postfix-review", "customize-opencode"],
            permissionMode: "build",
            memoryScope: "project",
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `快速代码探索子代理。适合按模式查找文件（如 "src/components/**/*.tsx"）、按关键词搜索代码（如 "API endpoints"），或回答代码库相关问题（如“API 端点是如何工作的”）。调用时请明确探索深度："quick" 表示基础搜索，"medium" 表示中等深度，"very thorough" 表示跨多个位置和命名方式的全面分析。`,
            prompt: PROMPT_EXPLORE,
            options: {
              omitInstructions: true,
            },
            mode: "subagent",
            native: true,
            permissionMode: "explore",
          },
          ...(flags.experimentalScout
            ? {
                scout: {
                  name: "scout",
                  permission: Permission.merge(
                    defaults,
                    Permission.fromConfig({
                      "*": "deny",
                      grep: "allow",
                      glob: "allow",
                      webfetch: "allow",
                      websearch: "allow",
                      read: "allow",
                      repo_clone: "allow",
                      repo_overview: "allow",
                      external_directory: {
                        ...readonlyExternalDirectory,
                        [path.join(Global.Path.repos, "*")]: "allow",
                      },
                    }),
                    user,
                  ),
                  description: `文档与依赖源码研究子代理。适合在不修改用户工作区的前提下查看外部文档、将依赖仓库克隆到托管缓存，并研究库的实现细节。`,
                  prompt: PROMPT_SCOUT,
                  options: {
                    omitInstructions: true,
                  },
                  mode: "subagent" as const,
                  native: true,
                  permissionMode: "scout" as const,
                },
              }
            : {}),
          debug_investigator: {
            name: "debug_investigator",
            description:
              "只读缺陷调查子代理。负责复现问题、追踪代码路径并收集证据，不编辑文件。",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                bash: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                webfetch: "allow",
                websearch: "allow",
                skill: "allow",
                debug_bootstrap: "allow",
                debug_report: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            options: {
              omitInstructions: true,
            },
            mode: "subagent",
            native: true,
            allowedTools: ["read", "glob", "grep", "bash", "skill", "debug_bootstrap", "debug_report"],
            skills: ["debug-bootstrap", "debug-postfix-review"],
            permissionMode: "explore",
            memoryScope: "project",
          },
          debug_qa: {
            name: "debug_qa",
            description:
              "Bug 修复验证子代理。负责重跑复现步骤、检查相邻流程，并在不进行大范围改动的前提下报告剩余风险。",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                bash: "allow",
                read: "allow",
                grep: "allow",
                glob: "allow",
                skill: "allow",
                debug_bootstrap: "allow",
                debug_report: "allow",
                debug_cleanup: "allow",
              }),
              user,
            ),
            options: {
              omitInstructions: true,
            },
            mode: "subagent",
            native: true,
            allowedTools: ["read", "glob", "grep", "bash", "skill", "debug_bootstrap", "debug_report", "debug_cleanup"],
            skills: ["debug-bootstrap", "debug-postfix-review"],
            permissionMode: "build",
            memoryScope: "project",
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
            permissionMode: "inherit",
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
            permissionMode: "inherit",
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
            permissionMode: "inherit",
          },
        }

        const permissionMode = (mode: PermissionMode | undefined) => {
          if (!mode || mode === "inherit") return Permission.merge(defaults, user)
          return agents[mode]?.permission ?? Permission.merge(defaults, user)
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: permissionMode(value.permission_mode),
              options: {},
              native: false,
            }
          if (value.model) {
            const resolved = cfg.model_alias?.[value.model.trim()] ?? value.model
            item.model = Provider.parseModel(resolved)
          }
          item.permissionMode = value.permission_mode ?? item.permissionMode
          if (value.permission_mode) item.permission = permissionMode(value.permission_mode)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.allowedTools = value.allowed_tools ?? item.allowedTools
          item.disallowedTools = value.disallowed_tools ?? item.disallowedTools
          item.skills = value.skills ?? item.skills
          item.background = value.background ?? item.background
          item.memoryScope = value.memory_scope ?? item.memoryScope
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export * as Agent from "./agent"
