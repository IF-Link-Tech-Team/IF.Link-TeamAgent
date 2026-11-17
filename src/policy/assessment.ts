/** Assessment validation: the shape the main Session answers with, and what makes an answer an acceptance. */
import { z } from 'zod'
import type { AssessmentOutcome, Gesture, Strength } from '../core/index.ts'
import type { RuleAssessment, Settings } from './schema.ts'

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
