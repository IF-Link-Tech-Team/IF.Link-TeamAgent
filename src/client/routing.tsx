/** Compact editors for worker runtimes and the task-routing table; every mapping is settings data, never code. */
import { Fragment, useState } from 'react'
import type { DispatchConfig, DispatchFamily, DispatchType, RuntimeProfile } from '../policy/index.ts'
import { usePanel } from './provider.tsx'
import { Button, DisclosureRow, Icon, InfoTip, Input, Switch } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { Field, Fields, useBlockDraft, useSettings } from './settings-kit.tsx'
import { Hint, Section } from './widgets.tsx'

/** One compact row per runtime; only the open row renders its full profile. */
export function RuntimesBlock() {
  const { t } = usePanel()
  const block = useSettings().settings.blocks.runtimes
  const draft = useBlockDraft('runtimes', block.value, block.revision)
  const value = draft.value
  const [open, setOpen] = useState<string>()
  const [newId, setNewId] = useState('')
  const set = (id: string, patch: Partial<RuntimeProfile>) => draft.edit({ ...value, [id]: { ...value[id]!, ...patch } })
  const add = () => {
    const id = newId.trim()
    if (!id || value[id]) return
    draft.edit({ ...value, [id]: { enabled: false, protocol: 'acp', command: '', args: [], env: {}, envFile: '', promptFiles: ['AGENTS.md'],
      modelMode: 'config', modelArg: '', mcpConfigPath: '', mcpExposure: '', concurrency: 1, maxWallMinutes: 60, maxTurns: 200 } })
    setNewId('')
  }
  const mode = (profile: RuntimeProfile) => profile.modelMode === 'config' ? t('runtimeModelConfig')
    : profile.modelMode === 'arg' ? t('runtimeModelArgMode') : t('runtimeModelNone')
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-form dt-block">
        <h2 className="dt-block-title">{t('runtimeTitle')}<InfoTip text={t('runtimeIntro')} /></h2>
        <Hint>{t('runtimeHint')}</Hint>
        <table className="dt-table dt-compact-table">
          <thead><tr><th>Runtime</th><th>{t('runtimeEnabled')}</th><th>{t('runtimeProtocol')}</th><th>{t('runtimeModelMode')}</th>
            <th>{t('runtimeCommand')}</th><th>{t('runtimeConcurrency')}</th><th /></tr></thead>
          <tbody>{Object.entries(value).map(([id, profile]) => <Fragment key={id}>
            <tr>
              <td><button type="button" className="dt-textlink dt-mono" onClick={() => setOpen(open === id ? undefined : id)}>{id}</button></td>
              <td><Switch label={t('runtimeEnabled')} checked={profile.enabled} onChange={enabled => set(id, { enabled })} /></td>
              <td className="dt-mono">{profile.protocol}</td>
              <td>{mode(profile)}</td>
              <td className="dt-mono dt-ellipsis" title={profile.command}>{profile.command || '—'}</td>
              <td>{profile.concurrency}</td>
              <td><Button variant="ghost" size="sm" icon={<Icon name={open === id ? 'chevron-up' : 'chevron-down'} size={14} />}
                aria-label={t('runtimeTitle')} title={t('runtimeTitle')} onClick={() => setOpen(open === id ? undefined : id)} /></td>
            </tr>
            {open === id && <tr><td colSpan={7}><div className="dt-inline-detail">
              <div className="dt-grid3">
                <Field label={t('runtimeCommand')} hint={t('runtimeCommandHint')}><Input className="dt-mono" value={profile.command}
                  onChange={event => set(id, { command: event.target.value })} /></Field>
                <Field label={t('runtimeArgs')}><Input className="dt-mono" value={profile.args.join(' ')}
                  onChange={event => set(id, { args: event.target.value.split(/\s+/).filter(Boolean) })} /></Field>
                <Field label={t('runtimePromptFiles')}><Input className="dt-mono" value={profile.promptFiles.join(' ')}
                  onChange={event => set(id, { promptFiles: event.target.value.split(/\s+/).filter(Boolean) })} /></Field>
              </div>
              <div className="dt-grid3">
                <Field label={t('runtimeModelMode')}><select className="dt-select" value={profile.modelMode}
                  onChange={event => set(id, { modelMode: event.target.value as RuntimeProfile['modelMode'] })}>
                  <option value="config">{t('runtimeModelConfig')}</option><option value="arg">{t('runtimeModelArgMode')}</option>
                  <option value="none">{t('runtimeModelNone')}</option>
                </select></Field>
                <Field label={t('runtimeModelArg')}><Input className="dt-mono" value={profile.modelArg} placeholder="--model {model}"
                  onChange={event => set(id, { modelArg: event.target.value })} /></Field>
                <Field label={t('runtimeEnvFile')} hint={t('runtimeEnvFileHint')}><Input className="dt-mono" value={profile.envFile}
                  onChange={event => set(id, { envFile: event.target.value })} /></Field>
              </div>
              <div className="dt-grid3">
                <Field label={t('runtimeConcurrency')}><Input type="number" min={1} max={16} value={profile.concurrency}
                  onChange={event => set(id, { concurrency: Number(event.target.value) })} /></Field>
                <Field label={t('runtimeWallMinutes')}><Input type="number" min={1} max={1440} value={profile.maxWallMinutes}
                  onChange={event => set(id, { maxWallMinutes: Number(event.target.value) })} /></Field>
                <Field label={t('runtimeTurns')}><Input type="number" min={1} max={1000} value={profile.maxTurns}
                  onChange={event => set(id, { maxTurns: Number(event.target.value) })} /></Field>
              </div>
              <div className="dt-grid3">
                <Field label={t('runtimeMcpConfigPath')} hint={t('runtimeMcpConfigPathHint')}>
                  <Input className="dt-mono" value={profile.mcpConfigPath} onChange={event => set(id, { mcpConfigPath: event.target.value })} /></Field>
                <Field label={t('runtimeMcpExposure')} hint={t('runtimeMcpExposureHint')}>
                  <Input className="dt-mono" value={profile.mcpExposure} onChange={event => set(id, { mcpExposure: event.target.value })} /></Field>
              </div>
              <Field label={t('runtimeEnv')}><textarea className="dt-textarea dt-mono" rows={2}
                value={Object.entries(profile.env).map(([key, item]) => `${key}=${item}`).join('\n')}
                onChange={event => set(id, { env: Object.fromEntries(event.target.value.split('\n').map(line => line.trim())
                  .filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at).trim(),
                    line.slice(at + 1)] })) })} /></Field>
              {id !== 'dsh' && <Button variant="ghost" size="sm" icon={<Icon name="trash" size={14} />} onClick={() => {
                const next = { ...value }
                delete next[id]
                setOpen(undefined)
                draft.edit(next)
              }}>{t('dispatchRemove')}</Button>}
            </div></td></tr>}
          </Fragment>)}</tbody>
        </table>
        <div className="dt-chain-add-row">
          <Input value={newId} placeholder={t('runtimeAdd')} onChange={event => setNewId(event.target.value)} />
          <Button variant="outline" icon={<Icon name="plus" size={14} />} disabled={!newId.trim() || !!value[newId.trim()]}
            onClick={add}>{t('runtimeAdd')}</Button>
        </div>
      </div>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}

/** The task table: types decide the family order, difficulty decides the model, and rules pin a type. */
export function DispatchBlock() {
  const { t } = usePanel()
  const { settings } = useSettings()
  const block = settings.blocks.dispatch
  const runtimes = settings.blocks.runtimes.value
  const draft = useBlockDraft('dispatch', block.value, block.revision)
  const value = draft.value
  const [openType, setOpenType] = useState<number>()
  const [advanced, setAdvanced] = useState(() => JSON.stringify({ models: value.models, capabilityFamilies: value.capabilityFamilies }, null, 2))
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedError, setAdvancedError] = useState('')
  const [newFamily, setNewFamily] = useState('')
  const edit = (patch: Partial<DispatchConfig>) => draft.edit({ ...value, ...patch })
  const editType = (index: number, patch: Partial<DispatchType>) => edit({ types: value.types.map((item, at) => at === index ? { ...item, ...patch } : item) })
  const editFamily = (id: string, patch: Partial<DispatchFamily>) => edit({ families: { ...value.families, [id]: { ...value.families[id]!, ...patch } } })
  const addFamily = () => {
    const id = newFamily.trim()
    if (!id || value.families[id]) return
    edit({ families: { ...value.families, [id]: { label: id, enabled: true, harness: Object.keys(runtimes)[0] ?? 'dsh',
      models: { S: '', M: '', L: '' }, harnessByModel: {}, account: '' } } })
    setNewFamily('')
  }
  const applyAdvanced = () => {
    try {
      const parsed = JSON.parse(advanced) as { models?: DispatchConfig['models']; capabilityFamilies?: DispatchConfig['capabilityFamilies'] }
      edit({ models: parsed.models ?? {}, capabilityFamilies: parsed.capabilityFamilies ?? {} })
      setAdvancedError('')
    } catch (error) { setAdvancedError(error instanceof Error ? error.message : String(error)) }
  }
  return <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className="dt-form dt-block">
        <h2 className="dt-block-title">{t('dispatchTitle')}<InfoTip text={t('dispatchIntro')} /></h2>
        <div className="dt-inline-controls">
          <Switch label={t('dispatchEnabled')} checked={value.enabled} onChange={enabled => edit({ enabled })} />
          <Field label={t('dispatchDefaultType')}><select className="dt-select" value={value.defaultType}
            onChange={event => edit({ defaultType: event.target.value })}>
            {value.types.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
          </select></Field>
          <Field label={t('dispatchFallbackFamily')}><select className="dt-select" value={value.fallbackFamily}
            onChange={event => edit({ fallbackFamily: event.target.value })}>
            {Object.keys(value.families).map(id => <option key={id} value={id}>{id}</option>)}
          </select></Field>
          <Field label={t('dispatchEscalateAfter')}><Input type="number" min={0} max={10} value={value.escalateAfter}
            onChange={event => edit({ escalateAfter: Number(event.target.value) })} /></Field>
        </div>
        <Hint>{t('dispatchIntro')}</Hint>
      </div>
      <Section title={t('dispatchTypes')}>
        <table className="dt-table dt-compact-table">
          <thead><tr><th>{t('dispatchTypeId')}</th><th>{t('dispatchTypeName')}</th><th>{t('dispatchTypeFamilies')}</th>
            <th>{t('dispatchTypeStrict')}</th><th /></tr></thead>
          <tbody>{value.types.map((item, index) => <Fragment key={index}>
            <tr>
              <td><Input className="dt-mono" value={item.id} onChange={event => editType(index, { id: event.target.value })} /></td>
              <td><Input value={item.name} onChange={event => editType(index, { name: event.target.value })} /></td>
              <td><Input className="dt-mono" value={item.families.join(',')}
                onChange={event => editType(index, { families: event.target.value.split(',').map(text => text.trim()).filter(Boolean) })} /></td>
              <td><Switch label={t('dispatchTypeStrict')} checked={item.strict} onChange={strict => editType(index, { strict })} /></td>
              <td><Button variant="ghost" size="sm" icon={<Icon name={openType === index ? 'chevron-up' : 'chevron-down'} size={14} />}
                aria-label={t('dispatchTypeRubric')} title={t('dispatchTypeRubric')}
                onClick={() => setOpenType(openType === index ? undefined : index)} />
                <Button variant="ghost" size="sm" icon={<Icon name="trash" size={14} />} aria-label={t('dispatchRemove')}
                  title={t('dispatchRemove')} onClick={() => edit({ types: value.types.filter((_, at) => at !== index) })} /></td>
            </tr>
            {openType === index && <tr><td colSpan={5}><div className="dt-inline-detail">
              <Field label={t('dispatchTypeDescription')}><Input value={item.description}
                onChange={event => editType(index, { description: event.target.value })} /></Field>
              <Field label={t('dispatchTypeRubric')}><div className="dt-grid3">
                {(['S', 'M', 'L'] as const).map(level => <Input key={level} value={item.rubric[level]} placeholder={level}
                  onChange={event => editType(index, { rubric: { ...item.rubric, [level]: event.target.value } })} />)}
              </div></Field>
            </div></td></tr>}
          </Fragment>)}</tbody>
        </table>
        <Button variant="outline" icon={<Icon name="plus" size={14} />} onClick={() => edit({ types: [...value.types, { id: `type-${value.types.length + 1}`,
          name: '', description: '', families: [], rubric: { S: '', M: '', L: '' }, strict: false }] })}>{t('dispatchAddType')}</Button>
      </Section>
      <Section title={t('dispatchFamilies')}>
        <table className="dt-table dt-compact-table">
          <thead><tr><th>{t('dispatchFamilyLabel')}</th><th>{t('dispatchFamilyEnabled')}</th><th>{t('dispatchFamilyHarness')}</th>
            <th>S</th><th>M</th><th>L</th><th>{t('dispatchFamilyAccount')}</th><th /></tr></thead>
          <tbody>{Object.entries(value.families).map(([id, family]) => <tr key={id}>
            <td><Input value={family.label} onChange={event => editFamily(id, { label: event.target.value })} /><small className="dt-mono">{id}</small></td>
            <td><Switch label={t('dispatchFamilyEnabled')} checked={family.enabled} onChange={enabled => editFamily(id, { enabled })} /></td>
            <td><select className="dt-select" value={family.harness} onChange={event => editFamily(id, { harness: event.target.value })}>
              {Object.keys(runtimes).map(runtime => <option key={runtime} value={runtime}>{runtime}</option>)}
            </select></td>
            {(['S', 'M', 'L'] as const).map(level => <td key={level}><Input className="dt-mono" value={family.models[level]} placeholder={level}
              onChange={event => editFamily(id, { models: { ...family.models, [level]: event.target.value } })} /></td>)}
            <td><Input className="dt-mono" value={family.account} onChange={event => editFamily(id, { account: event.target.value })} /></td>
            <td><Button variant="ghost" size="sm" icon={<Icon name="trash" size={14} />} aria-label={t('dispatchRemove')}
              title={t('dispatchRemove')} onClick={() => {
                const next = { ...value.families }
                delete next[id]
                edit({ families: next })
              }} /></td>
          </tr>)}</tbody>
        </table>
        <div className="dt-chain-add-row">
          <Input value={newFamily} placeholder={t('dispatchAddFamily')} onChange={event => setNewFamily(event.target.value)} />
          <Button variant="outline" icon={<Icon name="plus" size={14} />} disabled={!newFamily.trim() || !!value.families[newFamily.trim()]}
            onClick={addFamily}>{t('dispatchAddFamily')}</Button>
        </div>
      </Section>
      <Section title={t('dispatchRules')}>
        <table className="dt-table dt-compact-table">
          <thead><tr><th>{t('dispatchRuleCondition')}</th><th>{t('dispatchRuleType')}</th><th /></tr></thead>
          <tbody>{value.rules.map((rule, index) => <tr key={index}>
            <td><div className="dt-grid4">
              {(['label', 'source', 'chat', 'keyword'] as const).map(key => <Input key={key} className="dt-mono" value={rule.when[key] ?? ''} placeholder={key}
                onChange={event => edit({ rules: value.rules.map((item, at) => at === index ? { ...item, when: { ...item.when,
                  [key]: event.target.value || undefined } } : item) })} />)}
            </div></td>
            <td><select className="dt-select" value={rule.type}
              onChange={event => edit({ rules: value.rules.map((item, at) => at === index ? { ...item, type: event.target.value } : item) })}>
              {value.types.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
            </select></td>
            <td><Button variant="ghost" size="sm" icon={<Icon name="trash" size={14} />} aria-label={t('dispatchRemove')}
              title={t('dispatchRemove')} onClick={() => edit({ rules: value.rules.filter((_, at) => at !== index) })} /></td>
          </tr>)}</tbody>
        </table>
        <Button variant="outline" icon={<Icon name="plus" size={14} />} disabled={!value.types.length}
          onClick={() => edit({ rules: [...value.rules, { when: {}, type: value.types[0]!.id }] })}>{t('dispatchAddRule')}</Button>
      </Section>
      <DisclosureRow icon={<Icon name="settings" />} title={t('dispatchAdvanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}>
        <div className="dt-disclosure-body">
          <textarea className="dt-textarea dt-mono" rows={6} value={advanced} spellCheck={false} onChange={event => setAdvanced(event.target.value)} />
          {advancedError && <p className="dt-error">{advancedError}</p>}
          <Button variant="outline" onClick={applyAdvanced}>{t('dispatchAdvancedApply')}</Button>
        </div>
      </DisclosureRow>
    </Fields>
    <SaveBar {...draft} onDiscard={draft.discard} />
  </form>
}
