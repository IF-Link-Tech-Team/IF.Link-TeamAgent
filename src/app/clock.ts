/** The one clock the application may inject: domain timestamps read it, everything else reads the system time directly. */
export interface Clock {
  /** Milliseconds since the epoch, the value a caller would pass as `Date.now()`. */
  now(): number
}

/** The production clock. A test constructs its own `Clock` rather than replacing a global. */
export const systemClock: Clock = { now: () => Date.now() }
