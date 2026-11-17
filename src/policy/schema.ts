/**
 * Settings schema: every stored setting, its default, its bounds and its description, in one file.
 * This is the only place a setting is validated; adding one starts here and ends in the panel and a test.
 */
import { z } from 'zod'
import { LIMITS } from '../limits.ts'
import type { AdmissionRow } from '../admission.ts'
import { WORKER_COMMANDS } from '../infra/environment.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
const DEFAULT_RULES: Rule[] = [
  { id: 'copy', kind: 'work' as const, name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', kind: 'work' as const, name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction),
  /** A `gesture` rule asks for an emoji instead of a Ticket; a `work` rule asks for work. */
  kind: z.enum(['work', 'gesture']).default('work') }).strict()
export type Rule = z.infer<typeof RuleSchema>
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>
/**
 * The ordered routes one role tries after its primary model fails. Each entry is one provider × model pair, so the same
 * model may appear on two providers; an exact duplicate is refused rather than silently tried twice.
 */
export const FallbackSchema = z.array(RoleModelSchema).max(LIMITS.fallbacks.max)
  .refine(routes => new Set(routes.map(route => `${route.provider}/${route.model}`)).size === routes.length, 'Duplicate fallback route')
  .default([])
export type Fallback = z.infer<typeof FallbackSchema>

export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
const Weak = z.enum(['inferred', 'ignore'])
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: Weak.optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}) }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
export const PolicyConfigSchema = z.object({
  rules: z.array(RuleSchema).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs').default(DEFAULT_RULES),
  /** Whether a message that needs no work may still get a social reaction, and when that is only recorded. */
  gestures: z.object({
    mode: z.enum(['off', 'observe', 'auto']).default('observe'),
    /** How long before the same person may be reacted to again, and how many reactions one chat gets in a rolling hour. */
    personMinutes: z.number().int().min(LIMITS.gesturePersonMinutes.min).max(LIMITS.gesturePersonMinutes.max).default(30),
    perHour: z.number().int().min(LIMITS.gesturePerHour.min).max(LIMITS.gesturePerHour.max).default(2),
  }).strict().default({ mode: 'observe', personMinutes: 30, perHour: 2 }),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({}),
}).strict()
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  /**
   * How long an unaddressed human message waits for the rest of its thought before its Eval starts, so that several
   * bubbles carrying one meaning are judged together. A request that addresses the agent, a bot or a CI result never
   * waits; 0 turns the window off.
   */
  quietSeconds: z.number().int().min(0).max(LIMITS.quietSeconds.max).default(0),
  model: RoleModelSchema.nullable().default(null),
  /** Routes the main Session falls back to, in order, when its model request fails on the provider side. */
  fallbacks: FallbackSchema,
}).strict()
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare` command, and blocked commands. */
export const ExecutorConfigSchema = z.object({
  model: RoleModelSchema.nullable().default(null),
  /** Routes an Executor Session falls back to, in order, when its model request fails on the provider side. */
  fallbacks: FallbackSchema,
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty for <stateDir>/work').default(''),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
}).strict()
export const SourceInstanceSchema = z.object({ enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}) }).strict()
/** How the model router paces itself: how long a failed route is skipped, and how often the main Session's route is probed. */
export const RoutingConfigSchema = z.object({
  cooldownSeconds: z.number().int().min(LIMITS.routingCooldownSeconds.min).max(LIMITS.routingCooldownSeconds.max).default(300),
  probeSeconds: z.number().int().min(LIMITS.routingProbeSeconds.min).max(LIMITS.routingProbeSeconds.max).default(60),
}).strict()
/**
 * One worker runtime's launch profile. Every value is editable from the panel; the host reads it when it launches a
 * worker, so a new CLI or a changed path applies to the next Assignment without a restart. `command` may start with `~`.
 */
export const RuntimeProfileSchema = z.object({
  enabled: z.boolean().default(false),
  /** `dsh` runs in process; `acp` starts the command as an Agent Client Protocol stdio server. */
  protocol: z.enum(['dsh', 'acp']).default('acp'),
  command: z.string().trim().default(''),
  args: z.array(z.string()).default([]),
  /** Non-secret environment values; secrets belong in `envFile` (0600, KEY=VALUE lines). */
  env: z.record(z.string(), z.string()).default({}),
  envFile: z.string().trim().default(''),
  /** Files under the ticket directory that receive the worker prompt, such as AGENTS.md or CLAUDE.md. */
  promptFiles: z.array(z.string()).default([]),
  /** `config` uses ACP session config options, `arg` appends `modelArg` with `{model}`, `none` uses the CLI default. */
  modelMode: z.enum(['config', 'arg', 'none']).default('config'),
  modelArg: z.string().trim().default(''),
  /**
   * A harness configuration file that receives this installation's `teamagent` MCP server, for a runtime whose ACP
   * session ignores the `mcpServers` its client sends. `{package}` and `~` resolve at write time; values reference the
   * launch's `TEAMAGENT_MCP_*` variables. Empty writes nothing.
   */
  mcpConfigPath: z.string().trim().default(''),
  /** The `exposure` field that file carries, when the harness has one; empty omits it. */
  mcpExposure: z.string().trim().default(''),
  concurrency: z.number().int().min(1).max(LIMITS.maxWorkers.max).default(1),
  maxWallMinutes: z.number().int().min(LIMITS.runtimeMaxWallMinutes.min).max(LIMITS.runtimeMaxWallMinutes.max).default(60),
  maxTurns: z.number().int().min(LIMITS.runtimeMaxTurns.min).max(LIMITS.runtimeMaxTurns.max).default(200),
}).strict()
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>
const defaultRuntimes = (): Record<string, RuntimeProfile> => ({
  dsh: RuntimeProfileSchema.parse({ enabled: true, protocol: 'dsh' }),
  'kimi-code': RuntimeProfileSchema.parse({ command: '~/.kimi-code/bin/kimi', args: ['acp'], promptFiles: ['AGENTS.md'] }),
  antigravity: RuntimeProfileSchema.parse({ command: '~/.local/bin/agy', args: ['acp'], promptFiles: ['AGENTS.md'] }),
  'claude-code': RuntimeProfileSchema.parse({ command: '~/.local/bin/claude-agent-acp', promptFiles: ['CLAUDE.md'] }),
  // pi-acp stores the ACP `mcpServers` without connecting them, so pi reads the bridge from its own user-level file.
  pi: RuntimeProfileSchema.parse({ command: '~/.local/bin/pi-acp', promptFiles: ['AGENTS.md'],
    mcpConfigPath: '~/.pi/agent/mcp.json', mcpExposure: 'direct' }),
})
/** Difficulty levels are local to a task type: the same S means different work for `code` and `creative`. */
export const DifficultySchema = z.enum(['S', 'M', 'L'])
export type Difficulty = z.infer<typeof DifficultySchema>
const RubricSchema = z.object({ S: z.string().trim().default(''), M: z.string().trim().default(''), L: z.string().trim().default('') }).strict()
  .default(() => ({ S: '', M: '', L: '' }))
/** One task type, editable in the panel: its families decide the vendor order, its rubric decides difficulty. */
export const DispatchTypeSchema = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  /** Ordered family ids: the first one that has a healthy model for the difficulty wins. */
  families: z.array(z.string().trim().min(1)).default([]),
  rubric: RubricSchema,
  /** `true` refuses a cross-family fallback: the ticket waits instead of silently changing style. */
  strict: z.boolean().default(false),
}).strict()
export type DispatchType = z.infer<typeof DispatchTypeSchema>
/** One vendor/family: a default harness and the model used at each difficulty. Empty model = not configured. */
export const DispatchFamilySchema = z.object({
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  harness: z.string().trim().min(1),
  models: z.object({ S: z.string().trim().default(''), M: z.string().trim().default(''), L: z.string().trim().default('') }).strict()
    .default(() => ({ S: '', M: '', L: '' })),
  /** Per-model harness overrides, for a model reachable through more than one runtime. */
  harnessByModel: z.record(z.string(), z.string()).default({}),
  account: z.string().trim().default(''),
}).strict()
export type DispatchFamily = z.infer<typeof DispatchFamilySchema>
/** A deterministic rule that pins a trigger to a task type before the Router is asked. */
export const DispatchRuleSchema = z.object({
  when: z.object({
    label: z.string().trim().optional(),
    source: z.string().trim().optional(),
    chat: z.string().trim().optional(),
    keyword: z.string().trim().optional(),
  }).strict(),
  type: z.string().trim().min(1),
}).strict()
/** One model's metadata; it is shown to people and never enters the Router's prompt. */
export const DispatchModelSchema = z.object({
  harness: z.string().trim().default(''),
  effort: z.string().trim().default(''),
  cost: z.string().trim().default(''),
  note: z.string().trim().default(''),
  maxCostUsd: z.number().min(0).max(10_000).optional(),
}).strict()
/** Every type starts on DSH; the external families stay configured but disabled until someone enables them in the panel. */
const defaultDispatchTypes = (): DispatchType[] => [
  { id: 'research', name: '调研/核查', description: '调研、核查、对比、找资料', families: ['deepseek'], rubric: { S: '查一个事实', M: '对比几个方案', L: '多源调研 + 结论' }, strict: false },
  { id: 'creative', name: '设计/文案', description: '设计、文案、新闻稿、推文、海报', families: ['deepseek'], rubric: { S: '改文案、间距、小图', M: '新页面、新组件、活动配图', L: '新视觉体系、活动主视觉' }, strict: false },
  { id: 'writing', name: '文档', description: '文档、指南、模板、归档', families: ['deepseek'], rubric: { S: '改一段话', M: '写/改一篇文档', L: '多篇整合、对外长文' }, strict: false },
  { id: 'code', name: '代码', description: '实现、修 bug、重构、脚本', families: ['deepseek'], rubric: { S: '单文件、明确修复', M: '几个文件 + 测试', L: '跨模块、方案不确定' }, strict: false },
  { id: 'ops', name: '运维/接入', description: '服务器、账号、接入、数据', families: ['deepseek'], rubric: { S: '查状态', M: '接入/配置', L: '迁移/部署' }, strict: false },
  { id: 'coordination', name: '协调', description: '待办、活动、排期、群运营', families: ['deepseek'], rubric: { S: '列待办', M: '定活动/排期', L: '跨项目协调' }, strict: false },
  { id: 'chat', name: '轻回复', description: '天气、转达、简单问答', families: ['deepseek'], rubric: { S: '一句话回答', M: '查一下再答', L: '需要长答' }, strict: false },
]
const defaultDispatchFamilies = (): Record<string, DispatchFamily> => ({
  deepseek: { label: 'DeepSeek / DSH', enabled: true, harness: 'dsh', models: { S: '', M: '', L: '' }, harnessByModel: {}, account: '' },
  kimi: { label: 'Kimi', enabled: false, harness: 'kimi-code',
    models: { S: 'kimi-for-coding-highspeed', M: 'kimi-for-coding', L: 'k3.1-pro' }, harnessByModel: {}, account: '' },
  anthropic: { label: 'Claude', enabled: false, harness: 'claude-code',
    models: { S: 'haiku', M: 'sonnet', L: 'opus' }, harnessByModel: {}, account: '' },
  antigravity: { label: 'Antigravity', enabled: false, harness: 'antigravity', models: { S: '', M: '', L: '' }, harnessByModel: {}, account: '' },
  // pi names a model `provider/model`, so its slots start empty and the panel fills them in.
  pi: { label: 'Pi', enabled: false, harness: 'pi', models: { S: '', M: '', L: '' }, harnessByModel: {}, account: '' },
})
/**
 * Worker routing: task type decides the family order, difficulty decides the model, and the table stays editable in
 * the panel. `enabled: false` keeps the pre-existing DSH-only behaviour.
 */
export const DispatchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultType: z.string().trim().min(1).default('code'),
  /** The family used when no configured family is available; its harness must be enabled, or the host uses DSH. */
  fallbackFamily: z.string().trim().min(1).default('deepseek'),
  types: z.array(DispatchTypeSchema).default(() => defaultDispatchTypes()),
  families: z.record(z.string(), DispatchFamilySchema).default(() => defaultDispatchFamilies()),
  models: z.record(z.string(), DispatchModelSchema).default({}),
  /** Capability tags (browser, vision, feishu, ssh, repo) mapped to the families that satisfy them. */
  capabilityFamilies: z.record(z.string(), z.array(z.string().trim().min(1))).default({}),
  rules: z.array(DispatchRuleSchema).default([]),
  escalateAfter: z.number().int().min(LIMITS.dispatchEscalateAfter.min).max(LIMITS.dispatchEscalateAfter.max).default(2),
}).strict()
export type DispatchConfig = z.infer<typeof DispatchConfigSchema>
/** The Cloudflare Workers AI account and model that pick an emoji, and whether a pick runs at all. */
export const MarksConfigSchema = z.object({
  enabled: z.boolean().default(true),
  account: z.string().trim().default(''),
  /** Written by the panel; an API key, so it is masked in every read. An empty value falls back to the environment. */
  token: z.string().trim().default(''),
  model: z.string().trim().min(1).default('clef-flash'),
  timeoutMs: z.number().int().min(LIMITS.marksTimeoutMs.min).max(LIMITS.marksTimeoutMs.max).default(4000),
}).strict()
/** What a read returns where a secret is stored; saving the same text keeps the stored secret. */
export const SETTINGS_MASK = '••••••'
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
  routing: RoutingConfigSchema.default(() => RoutingConfigSchema.parse({})),
  marks: MarksConfigSchema.default(() => MarksConfigSchema.parse({})),
  runtimes: z.record(z.string(), RuntimeProfileSchema).default(() => defaultRuntimes()),
  dispatch: DispatchConfigSchema.default(() => DispatchConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsBlock = 'policy' | 'eval' | 'executor' | 'routing' | 'marks' | 'runtimes' | 'dispatch' | `source:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync'

