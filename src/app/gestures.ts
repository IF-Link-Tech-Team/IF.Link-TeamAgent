/** Keeping a chat's pace of social reactions: a person is not answered twice in a row, and a chat gets few. */
import type { Gesture, GestureBudget, Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

/** The default pace: how long a person waits before the agent may react to them again, and how many a chat gets in an hour. */
export const PERSON_MINUTES = 30, PER_HOUR = 2
/** The pace a deployment saved in the Policy; both numbers are read for every admission so a saved change applies at once. */
export interface GesturePace { personMinutes: number; perHour: number }
/**
 * Gestures admits a social reaction only when the chat has room for it: no reaction to the same person within
 * `personMinutes`, and fewer than `perHour` in the rolling hour. A refusal is recorded by the Decision, so a chat that
 * has had its share is visible rather than silent, and the pace lives in the Store so a restart does not start it over.
 */
export class Gestures implements GestureBudget {
  constructor(private readonly store: Pick<Store, 'get' | 'set'>, private readonly now: () => number = Date.now,
    private readonly pace: () => GesturePace = () => ({ personMinutes: PERSON_MINUTES, perHour: PER_HOUR })) {}
  admit(trigger: Trigger, _gesture: Gesture): boolean {
    const at = new Date(this.now()).toISOString()
    const chat = String(trigger.meta.chatId ?? '')
    const person = trigger.actor.id
    const { personMinutes, perHour } = this.pace()
    const last = this.store.get(KV.gestures.person(person))
    if (last && this.now() - Date.parse(last) < personMinutes * 60_000) return false
    const pace = this.store.get(KV.gestures.pace(chat))
    const within = pace && this.now() - Date.parse(pace.at) < 3600_000 ? pace.count : 0
    if (within >= perHour) return false
    this.store.set(KV.gestures.pace(chat), { at, count: within + 1 })
    this.store.set(KV.gestures.person(person), at)
    return true
  }
}
