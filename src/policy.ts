/**
 * Runtime settings schemas, assessment validation, and policy gate evaluation.
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
import { LIMITS } from './limits.ts'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { key, type AssessmentOutcome, type Gesture, type Mandate, type Policy, type PolicyEffect, type SourceScope, type Strength, type Thread, type Ticket,
  type Trigger, type ActorRef, type GateResult } from './core/index.ts'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  /** Present when the message asks for no work but does ask for a gesture, which the mode decides to draw or only record. */
  gesture?: { score: number; intent: Gesture['intent'] } | null | undefined
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
  /** Optional routing hints an assessment may give for an accepted proactive Ticket. */
  type?: string | null; difficulty?: 'S' | 'M' | 'L' | null; needs?: string[] | null
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  // A message that needs no work may still ask for a gesture: the mode decides whether it is drawn or only recorded.
  if (assessment.gesture) {
    const { score, intent } = assessment.gesture
    const gesture = { score, intent }
    const mode = settings.policy.gestures.mode
    if (mode === 'off') return { kind: 'ignore', reason: { code: 'gestureOff' }, audit }
    if (mode === 'observe' || score < 3) return { kind: 'ignore', reason: { code: 'gestureObserved',
      values: { intent, score: String(score) } }, audit: { ...audit, gesture } }
    return { kind: 'react', gesture, reason: assessment.reason, audit: { ...audit, gesture } }
  }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}),
    ...(assessment.type ? { type: assessment.type } : {}), ...(assessment.difficulty ? { difficulty: assessment.difficulty } : {}),
    ...(assessment.needs?.length ? { needs: assessment.needs } : {}) }
}
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
    personMinutes: z.number().int().min(1).max(1440).default(30),
    perHour: z.number().int().min(1).max(60).default(2),
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
  cooldownSeconds: z.number().int().min(10).max(3600).default(300),
  probeSeconds: z.number().int().min(10).max(600).default(60),
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
  concurrency: z.number().int().min(1).max(LIMITS.maxWorkers.max).default(1),
  maxWallMinutes: z.number().int().min(1).max(1440).default(60),
  maxTurns: z.number().int().min(1).max(1000).default(200),
}).strict()
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>
const defaultRuntimes = (): Record<string, RuntimeProfile> => ({
  dsh: RuntimeProfileSchema.parse({ enabled: true, protocol: 'dsh' }),
  'kimi-code': RuntimeProfileSchema.parse({ command: '~/.kimi-code/bin/kimi', args: ['acp'], promptFiles: ['AGENTS.md'] }),
  antigravity: RuntimeProfileSchema.parse({ command: '~/.local/bin/agy', args: ['acp'], promptFiles: ['AGENTS.md'] }),
  'claude-code': RuntimeProfileSchema.parse({ command: '~/.local/bin/claude-agent-acp', promptFiles: ['CLAUDE.md'] }),
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
  escalateAfter: z.number().int().min(0).max(10).default(2),
}).strict()
export type DispatchConfig = z.infer<typeof DispatchConfigSchema>
/** The Cloudflare Workers AI account and model that pick an emoji, and whether a pick runs at all. */
export const MarksConfigSchema = z.object({
  enabled: z.boolean().default(true),
  account: z.string().trim().default(''),
  /** Written by the panel; an API key, so it is masked in every read. An empty value falls back to the environment. */
  token: z.string().trim().default(''),
  model: z.string().trim().min(1).default('clef-flash'),
  timeoutMs: z.number().int().min(500).max(15000).default(4000),
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

export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export function policyVersion(settings: Settings): string {
  // A rule's `kind` joins the version only when it asks for a gesture: every work rule predates the field, and hashing it
  // would change every stored Policy version for no behaviour.
  const rules = settings.policy.rules.map(rule => rule.kind === 'work'
    ? { id: rule.id, name: rule.name, enabled: rule.enabled, instruction: rule.instruction } : rule)
  return key(POLICY_REVISION, JSON.stringify({ rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope, options: { degraded?: boolean } = {}): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  // While the main Session runs off a fallback model, its semantic judgement is not the one the team configured:
  // inferred work is left for a person instead of being accepted automatically.
  const degraded = options.degraded === true
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    quietMs: settings.eval.quietSeconds * 1000,
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => !degraded && mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
