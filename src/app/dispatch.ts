/** Deterministic worker routing: task type decides the family, difficulty decides the model, and every table is settings. */
import type { Difficulty, DispatchFamily, Settings } from '../policy.ts'

/** What the Router or a deterministic hint says about a ticket's work. */
export interface DispatchRequest {
  /** A task type id from `dispatch.types`; an unknown id falls back to the configured default. */
  type?: string
  difficulty?: Difficulty
  /** Capability tags such as `browser`, `vision`, `feishu`, `ssh` or `repo`. */
  needs?: string[]
  /** Deterministic hints used by `dispatch.rules`. */
  labels?: string[]
  source?: string
  chat?: string
  text?: string
}

/** The route a ticket runs on, with enough detail to explain it in the panel and to audit it later. */
export interface DispatchRoute {
  type: string
  difficulty: Difficulty
  family: string
  model: string
  harness: string
  account: string
  routeId: string
  /** True when the route came from a fallback rather than the configured first choice. */
  degraded: boolean
  reason: string
}

/** The configured fallback route, or DSH when its family or harness is not enabled. */
function fallback(settings: Settings, type: string, difficulty: Difficulty, reason: string, degraded: boolean): DispatchRoute {
  const id = settings.dispatch.fallbackFamily
  const family = settings.dispatch.families[id]
  const model = family ? modelAt(family, difficulty) : ''
  const harness = family && settings.runtimes[family.harness]?.enabled ? family.harness : 'dsh'
  return { type, difficulty, family: id, model, harness, account: family?.account ?? '', routeId: `${id}:${model || 'default'}`, degraded, reason }
}

/** The nearest configured model for a difficulty: an empty slot borrows the closest one instead of dropping the family. */
export function modelAt(family: DispatchFamily, difficulty: Difficulty): string {
  const exact = family.models[difficulty]
  if (exact) return exact
  const order: Record<Difficulty, Difficulty[]> = { S: ['M', 'L'], M: ['S', 'L'], L: ['M', 'S'] }
  for (const level of order[difficulty]) if (family.models[level]) return family.models[level]
  return ''
}

/** A rule's first match pins the type; a rule with no conditions matches every trigger. */
function ruleType(settings: Settings, request: DispatchRequest): string | undefined {
  for (const rule of settings.dispatch.rules) {
    const { label, source, chat, keyword } = rule.when
    if (source && source !== request.source) continue
    if (chat && !request.chat?.includes(chat)) continue
    if (label && !request.labels?.includes(label)) continue
    if (keyword && !request.text?.includes(keyword)) continue
    return rule.type
  }
  return undefined
}

/** The type to use: a rule wins, then the Router's choice, then the configured default, then the first type. */
function resolveType(settings: Settings, request: DispatchRequest): string {
  const types = settings.dispatch.types
  const known = (id: string | undefined): id is string => !!id && types.some(type => type.id === id)
  return [ruleType(settings, request), request.type, settings.dispatch.defaultType].find(known) ?? types[0]?.id ?? 'code'
}

/** Whether a family satisfies every capability tag that has a configured mapping. */
function satisfies(family: string, needs: string[], settings: Settings): boolean {
  return needs.every(need => {
    const allowed = settings.dispatch.capabilityFamilies[need]
    return !allowed || allowed.length === 0 || allowed.includes(family)
  })
}

/**
 * Resolve one ticket to a concrete route. The function reads settings only, so the same inputs always produce the same
 * route; health and quota checks belong to the executor, which may skip a route it cannot launch.
 */
export function chooseRoute(settings: Settings, request: DispatchRequest): DispatchRoute {
  const dispatch = settings.dispatch
  const type = resolveType(settings, request)
  const difficulty = request.difficulty ?? 'M'
  if (!dispatch.enabled) return fallback(settings, type, difficulty, 'dispatch is off; the DSH worker keeps its configured model', false)
  const selected = dispatch.types.find(item => item.id === type)
  if (!selected) return fallback(settings, type, difficulty, `unknown task type ${type}; DSH fallback`, true)
  const needs = request.needs ?? []
  for (const id of selected.families) {
    const family = dispatch.families[id]
    if (!family || !family.enabled) continue
    if (!satisfies(id, needs, settings)) continue
    const model = modelAt(family, difficulty)
    const harness = (model && family.harnessByModel[model]) || family.harness
    const runtime = settings.runtimes[harness]
    if (!runtime?.enabled) continue
    // A DSH family may leave the model empty: the existing executor model and fallback chain still apply.
    if (!model && runtime.protocol !== 'dsh') continue
    return { type, difficulty, family: id, model, harness, account: family.account,
      routeId: `${id}:${model || 'default'}`, degraded: false, reason: `${type}/${difficulty} → ${id}` }
  }
  const reason = selected.strict
    ? `${type}/${difficulty}: no configured family is available and the type is strict`
    : `${type}/${difficulty}: no configured family is available; DSH fallback`
  return fallback(settings, type, difficulty, reason, true)
}
