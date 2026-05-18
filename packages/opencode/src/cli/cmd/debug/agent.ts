import { EOL } from "os"
import { basename } from "path"
import { Effect } from "effect"
import { Agent } from "../../../agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { MessageV2 } from "../../../session/message-v2"
import { MessageID, PartID } from "../../../session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "../../../permission"
import { iife } from "../../../util/iife"
import { effectCmd, fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Skill } from "@/skill"

export const AgentCommand = effectCmd({
  command: "agent <name>",
  describe: "show agent configuration details",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        demandOption: true,
        description: "Agent name",
      })
      .option("tool", {
        type: "string",
        description: "Tool id to execute",
      })
      .option("params", {
        type: "string",
        description: "Tool params as JSON or a JS object literal",
      }),
  handler: Effect.fn("Cli.debug.agent")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    return yield* run(args, ctx)
  }),
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  ctx: InstanceContext,
) {
  const agentName = args.name
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  if (!agent) {
    process.stderr.write(
      `Agent ${agentName} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  const inventory = yield* getInventory(agent)
  const resolvedTools = resolveTools(agent, inventory.availableTools)
  const toolID = args.tool
  if (toolID) {
    const tool = inventory.availableTools.find((item) => item.id === toolID)
    if (!tool) {
      process.stderr.write(`Tool ${toolID} not found for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    if (resolvedTools[toolID] === false) {
      process.stderr.write(`Tool ${toolID} is disabled for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    const params = parseToolParams(args.params)
    const toolCtx = yield* createToolContext(agent, ctx)
    const result = yield* tool.execute(params, toolCtx)
    process.stdout.write(JSON.stringify({ tool: toolID, input: params, result }, null, 2) + EOL)
    return
  }

  const output = debugOutput(agent, inventory, resolvedTools)
  process.stdout.write(JSON.stringify(output, null, 2) + EOL)
})

type Inventory = {
  model: Agent.Info["model"]
  allToolIDs: string[]
  availableTools: { id: string }[]
  allSkillNames: string[]
  availableSkillNames: string[]
}

const getInventory = Effect.fn("Cli.debug.agent.getInventory")(function* (agent: Agent.Info) {
  const provider = yield* Provider.Service
  const registry = yield* ToolRegistry.Service
  const skill = yield* Skill.Service
  const model = agent.model ?? (yield* provider.defaultModel())
  const allTools = yield* registry.all()
  const availableTools = yield* registry.tools({ ...model, agent })
  const allSkills = yield* skill.all()
  const availableSkills = yield* skill.available(agent)
  return {
    model,
    allToolIDs: allTools.map((tool) => tool.id).toSorted(),
    availableTools,
    allSkillNames: allSkills.map((skill) => skill.name).toSorted(),
    availableSkillNames: availableSkills.map((skill) => skill.name).toSorted(),
  } satisfies Inventory
})

function resolveTools(agent: Agent.Info, availableTools: { id: string }[]) {
  const disabled = Permission.disabled(
    availableTools.map((tool) => tool.id),
    agent.permission,
  )
  const resolved: Record<string, boolean> = {}
  for (const tool of availableTools) {
    resolved[tool.id] = !disabled.has(tool.id)
  }
  return resolved
}

function debugOutput(agent: Agent.Info, inventory: Inventory, tools: Record<string, boolean>) {
  const disabledByPermission = Object.entries(tools)
    .filter((entry) => entry[1] === false)
    .map((entry) => entry[0])
    .toSorted()
  const exposedTools = Object.entries(tools)
    .filter((entry) => entry[1] === true)
    .map((entry) => entry[0])
    .toSorted()
  const hiddenByAgentBoundary = inventory.allToolIDs.filter((tool) => !Agent.allowsTool(agent, tool)).toSorted()
  const missingTools = [...(agent.allowedTools ?? []), ...(agent.disallowedTools ?? [])].filter(
    (tool, index, list) => list.indexOf(tool) === index && !inventory.allToolIDs.includes(tool),
  )
  const hiddenSkills = inventory.allSkillNames
    .filter((skill) => !inventory.availableSkillNames.includes(skill))
    .toSorted()
  const missingSkills = (agent.skills ?? []).filter(
    (skill, index, list) => list.indexOf(skill) === index && !inventory.allSkillNames.includes(skill),
  )

  return {
    name: agent.name,
    description: agent.description,
    mode: agent.mode,
    native: agent.native,
    hidden: agent.hidden,
    model: inventory.model,
    variant: agent.variant,
    temperature: agent.temperature,
    topP: agent.topP,
    permissionMode: agent.permissionMode,
    background: agent.background,
    memoryScope: agent.memoryScope,
    prompt: agent.prompt
      ? {
          configured: true,
          length: agent.prompt.length,
        }
      : {
          configured: false,
        },
    options: agent.options,
    boundaries: {
      allowedTools: agent.allowedTools ?? [],
      disallowedTools: agent.disallowedTools ?? [],
      skills: agent.skills ?? [],
    },
    tools: {
      exposed: exposedTools,
      disabledByPermission,
      hiddenByAgentBoundary,
      configuredMissing: missingTools.toSorted(),
    },
    skills: {
      visible: inventory.availableSkillNames,
      hiddenByAgentBoundary: hiddenSkills,
      configuredMissing: missingSkills.toSorted(),
    },
    diagnostics: diagnostics({ agent, missingTools, missingSkills, exposedTools }),
  }
}

function diagnostics(input: {
  agent: Agent.Info
  missingTools: string[]
  missingSkills: string[]
  exposedTools: string[]
}) {
  return [
    ...(input.missingTools.length
      ? [
          {
            level: "warning",
            message:
              "Some configured tools are not registered in the builtin/custom tool registry. MCP tools may be absent from this inventory until their server is connected.",
            tools: input.missingTools.toSorted(),
          },
        ]
      : []),
    ...(input.missingSkills.length
      ? [
          {
            level: "warning",
            message: "Some configured skills are not currently discovered.",
            skills: input.missingSkills.toSorted(),
          },
        ]
      : []),
    ...(input.agent.allowedTools?.length && input.exposedTools.length === 0
      ? [
          {
            level: "warning",
            message: "allowedTools is set, but no tools are exposed after model, agent, and permission filtering.",
          },
        ]
      : []),
  ]
}

function parseToolParams(input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch (jsonError) {
      try {
        return new Function(`return (${trimmed})`)()
      } catch (evalError) {
        throw new Error(
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError}. Eval error: ${evalError}.`,
          { cause: evalError },
        )
      }
    }
  })

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool params must be an object.")
  }
  return parsed as Record<string, unknown>
}

const createToolContext = Effect.fn("Cli.debug.agent.createToolContext")(function* (
  agent: Agent.Info,
  ctx: InstanceContext,
) {
  const sessionSvc = yield* Session.Service
  const session = yield* sessionSvc.create({ title: `Debug tool run (${agent.name})` })
  const messageID = MessageID.ascending()
  const model = agent.model
    ? agent.model
    : yield* Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.defaultModel()
      })
  const now = Date.now()
  const message: MessageV2.Assistant = {
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    time: { created: now },
    parentID: messageID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "debug",
    agent: agent.name,
    path: {
      cwd: ctx.directory,
      root: ctx.worktree,
    },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  yield* sessionSvc.updateMessage(message)

  const ruleset = Permission.merge(agent.permission, session.permission ?? [])

  return {
    sessionID: session.id,
    messageID,
    callID: PartID.ascending(),
    agent: agent.name,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask(req: Omit<Permission.Request, "id" | "sessionID" | "tool">) {
      return Effect.sync(() => {
        for (const pattern of req.patterns) {
          const rule = Permission.evaluate(req.permission, pattern, ruleset)
          if (rule.action === "deny") {
            throw new Permission.DeniedError({ ruleset })
          }
        }
      })
    },
  }
})
