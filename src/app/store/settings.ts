/** Versioned settings: the current block values, each block's revision, and the history a person can restore. */
import { KV } from '../../kv.ts'
import { SettingsSchema, type Settings, type SettingsOrigin, type SettingsSave } from '../../policy/index.ts'
import { Versions } from '../versions.ts'
import type { StoreCore } from './core.ts'

/** Saved settings snapshot with the policy version and ticket notifications it produced (`internal` saves have no origin). */
export interface SettingsVersion {
  revision: number; savedAt: string; source: SettingsOrigin | 'internal'; block?: SettingsSave
  policyVersion: string; policyChanged: boolean; notified: string[]; settings: Settings
}

export interface SettingsStore {
  /** Current validated settings, parsed from the latest snapshot. */
  settings(): Settings
  /** Revision of one settings block; each page saves against its own block for optimistic concurrency. */
  blockRevision(block: SettingsSave): number
  /** Saves settings as the next revision (making it current) and increments `record.block`'s counter when present. */
  save(value: unknown, record: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'>): Settings
  /** Saved revisions, newest first; revisions predating settings history are absent. */
  history(limit?: number): SettingsVersion[]
}

export function createSettings(core: StoreCore): SettingsStore {
  const versions = new Versions<SettingsVersion>(core, KV.settings.revision, KV.settings.version)
  const store: SettingsStore = {
    settings: () => SettingsSchema.parse(versions.current()?.settings ?? {}),
    blockRevision: block => core.get(KV.settings.block(block)) ?? 0,
    save: (value, record) => {
      const settings = SettingsSchema.parse(value)
      return core.atomic(() => {
        versions.save(revision => ({ ...record, revision, savedAt: new Date().toISOString(), settings }))
        if (record.block) core.set(KV.settings.block(record.block), store.blockRevision(record.block) + 1)
        return settings
      })
    },
    history: (limit = 20) => versions.list(limit),
  }
  return store
}
