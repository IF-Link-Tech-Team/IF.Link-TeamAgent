/** Validation bounds shared between host schemas and management panel forms. */
export const LIMITS = {
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  /** The longest an unaddressed message may wait for the rest of its thought. */
  quietSeconds: { min: 0, max: 300 },
  maxWorkers: { min: 1, max: 16 },
  prepareCommand: 4000,
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
  /** How many fallback routes one role may queue behind its primary model. */
  fallbacks: { max: 5 },
  /** Reaction pacing: how long before the same person may be reacted to again, and a chat's rolling hour. */
  gesturePersonMinutes: { min: 1, max: 1440 },
  gesturePerHour: { min: 1, max: 60 },
  /** The emoji pick's own deadline; longer than a provider outage is worth waiting for a mark. */
  marksTimeoutMs: { min: 500, max: 15000 },
  /** Route cooldown after a provider failure, and how often a cooling main route is probed. */
  routingCooldownSeconds: { min: 10, max: 3600 },
  routingProbeSeconds: { min: 10, max: 600 },
  /** External worker runtime limits, per Assignment. */
  runtimeMaxWallMinutes: { min: 1, max: 1440 },
  runtimeMaxTurns: { min: 1, max: 1000 },
  /** How many passing failures a ticket may ride out before it is escalated to another family. */
  dispatchEscalateAfter: { min: 0, max: 10 },
  /** The longest `every N hours` a scheduled job may ask for. */
  scheduleEveryHours: { min: 1, max: 168 },
} as const
