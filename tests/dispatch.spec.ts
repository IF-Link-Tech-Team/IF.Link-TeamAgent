import { describe, expect, it } from 'vitest'
import { SettingsSchema, type Settings } from '../src/policy/index.ts'
import { chooseRoute, modelAt, taskModel } from '../src/app/dispatch.ts'

const settings = (patch: (value: Settings) => void = () => {}): Settings => {
  const value = SettingsSchema.parse({})
  value.dispatch.enabled = true
  value.dispatch.types = [{ id: 'creative', name: 'Design', description: '', families: ['kimi', 'deepseek'], rubric: { S: '', M: '', L: '' }, strict: false }]
  value.dispatch.families = {
    kimi: { label: 'Kimi', enabled: true, harness: 'kimi-code', models: { S: 'kimi-small', M: 'kimi-medium', L: 'kimi-large' }, harnessByModel: {}, account: '' },
    deepseek: { label: 'DeepSeek', enabled: true, harness: 'dsh', models: { S: '', M: '', L: '' }, harnessByModel: {}, account: '' },
  }
  value.runtimes['kimi-code'] = { ...value.runtimes['kimi-code']!, enabled: true, command: 'kimi', args: ['acp'] }
  patch(value)
  return value
}

describe('task routing', () => {
  it('ships every type on DSH and every external runtime off until someone enables one', () => {
    const value = SettingsSchema.parse({})
    expect(value.dispatch.enabled).toBe(false)
    expect(value.dispatch.types.every(type => type.families.length === 1 && type.families[0] === 'deepseek')).toBe(true)
    expect(value.runtimes.dsh?.enabled).toBe(true)
    for (const id of ['kimi-code', 'antigravity', 'claude-code', 'pi']) expect(value.runtimes[id]?.enabled).toBe(false)
    // pi reads the bridge from its own config file; nothing else is preconfigured for it.
    expect(value.runtimes.pi).toMatchObject({ mcpConfigPath: '~/.pi/agent/mcp.json', mcpExposure: 'direct' })
    expect(value.executor.model).toBeNull()
  })

  it('resolves a bounded task type to a provider/model/effort even while Worker dispatch is off', () => {
    const value = settings(settings => {
      settings.dispatch.enabled = false
      settings.dispatch.types.push({ id: 'iflist-intake', name: 'IF.List intake', description: '', families: ['cilai-default'],
        rubric: { S: '', M: '', L: '' }, strict: false })
      settings.dispatch.families['cilai-default'] = { label: 'HY4 Flash', enabled: true, harness: 'dsh',
        models: { S: 'hy4-flash', M: 'hy4-flash', L: 'hy4-flash' }, harnessByModel: {}, account: '' }
      settings.dispatch.models['hy4-flash'] = { harness: 'dsh', effort: 'low', cost: '', note: '' }
    })
    expect(taskModel(value, 'iflist-intake')).toEqual({ family: 'cilai-default', provider: 'cilai-default', model: 'hy4-flash', effort: 'low' })
  })

  it('keeps every ticket on DSH while dispatch is off', () => {
    const route = chooseRoute(SettingsSchema.parse({}), { type: 'creative', difficulty: 'L' })
    expect(route).toMatchObject({ harness: 'dsh', family: 'deepseek', degraded: false })
  })

  it('uses the type family order and the difficulty model', () => {
    expect(chooseRoute(settings(), { type: 'creative', difficulty: 'L' })).toMatchObject({ family: 'kimi', model: 'kimi-large',
      harness: 'kimi-code', degraded: false })
  })

  it('borrows the nearest model when a difficulty slot is empty', () => {
    const value = settings(settings => { settings.dispatch.families.kimi!.models.M = '' })
    expect(modelAt(value.dispatch.families.kimi!, 'M')).toBe('kimi-small')
    expect(chooseRoute(value, { type: 'creative', difficulty: 'M' })).toMatchObject({ model: 'kimi-small', family: 'kimi' })
  })

  it('pins a type by a deterministic rule before the Router decides', () => {
    const value = settings(settings => { settings.dispatch.rules = [{ when: { label: 'docs' }, type: 'creative' }] })
    expect(chooseRoute(value, { type: 'code', labels: ['docs'], difficulty: 'S' })).toMatchObject({ type: 'creative' })
  })

  it('skips a family whose runtime is disabled and falls back to the next', () => {
    const value = settings(settings => { settings.runtimes['kimi-code']!.enabled = false })
    expect(chooseRoute(value, { type: 'creative', difficulty: 'L' })).toMatchObject({ family: 'deepseek', harness: 'dsh' })
  })

  it('filters a family by a capability map and falls back to DSH when none matches', () => {
    const value = settings(settings => {
      settings.dispatch.capabilityFamilies = { browser: ['antigravity'] }
      settings.dispatch.families.antigravity = { label: 'Antigravity', enabled: false, harness: 'antigravity', models: { S: 'g', M: 'g', L: 'g' },
        harnessByModel: {}, account: '' }
    })
    expect(chooseRoute(value, { type: 'creative', difficulty: 'M', needs: ['browser'] })).toMatchObject({ harness: 'dsh', degraded: true })
  })

  it('marks a strict type as degraded rather than silently using another family', () => {
    const value = settings(settings => {
      settings.dispatch.types[0]!.strict = true
      settings.dispatch.families.kimi!.enabled = false
      settings.dispatch.families.deepseek!.enabled = false
    })
    expect(chooseRoute(value, { type: 'creative', difficulty: 'M' })).toMatchObject({ harness: 'dsh', degraded: true })
  })
})
