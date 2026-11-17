/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement,
  type ReactNode } from 'react'
import type { ApiResponse } from '../app/api.ts'
import type { FieldSpec, Localized } from '../sources/kind.ts'
import { usePoll, type HistoryView, type Settings, type SettingsView, type SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, SegmentedControl, StateDot, Switch } from './controls.tsx'
import { useDraft } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './tabs.ts'
import { errorText, localized, valueLabel, when, type T } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => text.trim() ? Number(text) : null
/** Read a dotted path (`heartbeat.activeHours.start`) out of a source's configuration object. */
export function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key] : undefined, source)
}
/** Copy `source` along `path` and set the leaf, so React state and drafts never share a nested object with the saved value. */
export function writePath(source: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.')
  if (!head) return source
  const child = source[head]
  return { ...source, [head]: rest.length ? writePath(child && typeof child === 'object' ? child as Record<string, unknown> : {},
    rest.join('.'), value) : value }
}
interface SettingsData { settings: SettingsView; reload: () => Promise<void> }
const SettingsContext = createContext<SettingsData | undefined>(undefined)
export function useSettings(): SettingsData {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('A settings block rendered outside the settings')
  return value
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET settings'), [call, restarts])
  if (!data) return <LoadState error={error} loading />
  return <SettingsContext.Provider value={{ settings: data, reload }}>
    {error && <LoadState error={error} loading={false} />}
    {children}
  </SettingsContext.Provider>
}
export function useBlockDraft<V>(block: string, saved: V, revision: number, toValue: (draft: V) => unknown = draft => draft) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const { reload } = useSettings()
  return useDraft({ key: `dsh-superagent/draft/${state?.mainSessionId ?? ''}/${block}`, saved, revision, reload, save: async (value, from) => {
    const result = await call('PUT settings/:block', { block, body: { value: toValue(value), revision: from } })
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    return result
  } })
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null
    else if (focused.current && (!active
      || active === document.body)) { focused.current.focus({ preventScroll: true }); focused.current = null }
  }, [disabled])
  return <fieldset ref={set} className="dt-fieldset" disabled={disabled}>{children}</fieldset>
}
export function Field({ label, hint, note,
  children }: { label: string; hint?: string | undefined; note?: ReactNode; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return <div className="dt-field">
    <span className="dt-field-head"><label htmlFor={id}>{label}</label>{hint && <InfoTip text={hint} />}</span>{cloneElement(children,
      { id })}{note && <small>{note}</small>}
  </div>
}
function SwitchRow({ label, hint, checked,
  onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (next: boolean) => void }) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</div><Switch checked={checked} onChange={onChange}
      label={label} />
  </div>
}
type RoleModel = Settings['eval']['model']
export function ModelField({ id, value, onChange }: { id: string; value: RoleModel; onChange: (next: RoleModel) => void }) {
  const { t, call } = usePanel()
  const [catalog, setCatalog] = useState<ApiResponse<'GET models'>>()
  const [error, setError] = useState<string>()
  useEffect(() => { call('GET models').then(setCatalog, failure => setError(errorText(failure))) }, [call])
  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next }
    onChange(provider.trim() || model.trim() || effort.trim() ? { provider, model, ...effort ? { reasoningEffort: effort } : {} } : null)
  }
  const models = catalog?.groups.find(group => group.id === current.provider.trim())?.models ?? []
  const fallback = catalog?.default
  const input = (name: keyof typeof current, label: string, placeholder: string) => <Field label={label}>
    <Input list={`${id}-${name}s`} spellCheck={false} placeholder={placeholder} value={current[name]}
      onChange={event => set({ [name]: event.target.value })} />
  </Field>
  return <div className="dt-model">
    <Hint>{fallback ? t('defaultModel', { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort
      ? ` · ${fallback.reasoningEffort}` : ''}` }) : t('defaultModelUnavailable')}</Hint>
    {error && <p className="dt-error">{t('modelCatalogError', { error })}</p>}
    <div className="dt-grid3">
      {input('provider', t('modelProvider'), t('modelInherit'))}{input('model', t('modelName'), t('modelInherit'))}{input('effort',
        t('modelEffort'), t('modelEffortDefault'))}
    </div>
    <datalist id={`${id}-providers`}>{catalog?.groups.map(group => <option key={group.id}
      value={group.id}>{group.name}</option>)}</datalist>
    <datalist id={`${id}-models`}>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
    <datalist id={`${id}-efforts`}>
      {(models.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []).map(effort => <option key={effort.id}
        value={effort.id}>{effort.name}</option>)}
    </datalist>
  </div>
}

type ChainRoute = NonNullable<RoleModel>
type RouteRow = SettingsView['routes'][number]
/**
 * Ordered fallback chain for one role: every row is one Provider × model pair, arranged by drag or by the arrow buttons.
 * A row shows the route's live cooldown state, so a failed provider is visible where its chain is edited.
 */
export function ModelChainField({ id, role, value, primary, onChange }: {
  id: string; role: 'main' | 'worker'; value: ChainRoute[]; primary: RoleModel; onChange: (next: ChainRoute[]) => void
}) {
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const [catalog, setCatalog] = useState<ApiResponse<'GET models'>>()
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useState({ provider: '', model: '', effort: '' })
  const [dragging, setDragging] = useState<number | undefined>()
  useEffect(() => { call('GET models').then(setCatalog, failure => setError(errorText(failure))) }, [call])
  const states = settings.routes.filter(state => state.role === role)
  const stateOf = (route: ChainRoute): RouteRow | undefined => states.find(state => state.provider === route.provider && state.model === route.model)
  const same = (a: ChainRoute, b: ChainRoute) => a.provider === b.provider && a.model === b.model
  const taken = (route: ChainRoute) => value.some(item => same(item, route)) || (primary !== null && same(primary, route))
  const models = catalog?.groups.find(group => group.id === draft.provider)?.models ?? []
  const efforts = models.find(model => model.id === draft.model)?.reasoning?.efforts ?? []
  const candidate: ChainRoute | null = draft.provider.trim() && draft.model.trim()
    ? { provider: draft.provider.trim(), model: draft.model.trim(), ...draft.effort ? { reasoningEffort: draft.effort } : {} } : null
  const add = () => {
    if (!candidate || taken(candidate)) return
    onChange([...value, candidate])
    setDraft({ provider: '', model: '', effort: '' })
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return
    const next = value.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    onChange(next)
  }
  const label = (route: ChainRoute) => `${route.provider} / ${route.model}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ''}`
  return <div className="dt-chain">
    <div className="dt-field-head"><span>{t('fallbackTitle')}</span><InfoTip text={t('fallbackHint')} /></div>
    {error && <p className="dt-error">{t('modelCatalogError', { error })}</p>}
    {value.length === 0 ? <p className="dt-hint">{t('fallbackEmpty')}</p> : <ol className="dt-chain-list">
      {value.map((route, index) => {
        const state = stateOf(route)
        const cooling = state?.state === 'cooling'
        return <li key={`${route.provider}/${route.model}`} className="dt-chain-row" data-dragging={dragging === index || undefined}
          onDragOver={event => { if (dragging !== undefined) event.preventDefault() }}
          onDrop={event => { event.preventDefault(); if (dragging !== undefined) move(dragging, index); setDragging(undefined) }}>
          <span className="dt-chain-rank">{index + 1}</span>
          <span className="dt-chain-handle" draggable title={t('fallbackDrag')} aria-hidden="true"
            onDragStart={() => setDragging(index)} onDragEnd={() => setDragging(undefined)}>⠿</span>
          <span className="dt-chain-route" title={label(route)}>{label(route)}</span>
          {state && <span className="dt-chain-state" title={cooling && state.until ? t('fallbackStateCooling', { until: when(state.until, t('lang')) })
            : t('fallbackStateReady')}>
            <StateDot state={cooling ? 'warning' : 'done'} />
          </span>}
          <span className="dt-chain-actions">
            <Button variant="ghost" size="sm" icon={<Icon name="chevron-up" size={14} />} aria-label={t('fallbackMoveUp')} title={t('fallbackMoveUp')}
              disabled={index === 0} onClick={() => move(index, index - 1)} />
            <Button variant="ghost" size="sm" icon={<Icon name="chevron-down" size={14} />} aria-label={t('fallbackMoveDown')} title={t('fallbackMoveDown')}
              disabled={index === value.length - 1} onClick={() => move(index, index + 1)} />
            <Button variant="ghost" size="sm" icon={<Icon name="trash" size={14} />} aria-label={t('fallbackRemove', { route: label(route) })}
              title={t('fallbackRemove', { route: label(route) })}
              onClick={() => onChange(value.filter((_, at) => at !== index))} />
          </span>
        </li>
      })}
    </ol>}
    <div className="dt-chain-add">
      <label className="dt-chain-add-label" htmlFor={`${id}-provider`}>{t('fallbackAddHint')}</label>
      <div className="dt-grid3">
        <select id={`${id}-provider`} className="dt-select" aria-label={t('modelProvider')} value={draft.provider}
          onChange={event => setDraft({ provider: event.target.value, model: '', effort: '' })}>
          <option value="">{t('modelProvider')}</option>
          {catalog?.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <select id={`${id}-model`} className="dt-select" aria-label={t('modelName')} value={draft.model} disabled={!draft.provider}
          onChange={event => setDraft({ ...draft, model: event.target.value, effort: '' })}>
          <option value="">{t('modelName')}</option>
          {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
        <select id={`${id}-effort`} className="dt-select" aria-label={t('modelEffort')} value={draft.effort} disabled={efforts.length === 0}
          onChange={event => setDraft({ ...draft, effort: event.target.value })}>
          <option value="">{t('modelEffortDefault')}</option>
          {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
        </select>
      </div>
      <div className="dt-chain-add-row">
        <Button variant="outline" icon={<Icon name="plus" size={14} />} disabled={!candidate || taken(candidate)}
          title={candidate && taken(candidate) ? t('fallbackDuplicate') : undefined} onClick={add}>{t('fallbackAdd')}</Button>
        {candidate && taken(candidate) && <span className="dt-hint">{t('fallbackDuplicate')}</span>}
      </div>
    </div>
  </div>
}

type HistoryChange = NonNullable<HistoryView['items'][number]['changes']>[number]
function changeText(t: T, change: HistoryChange, sources: SourceView[]): string {
  const source = sources.find(item => item.id === change.source)
  const field = (change.part ? source?.policy?.fields : source?.fields)?.find(item => item.key === change.field)
  const shown = (value: unknown) => value === undefined || value === null || value === '' ? t('unsetValue') : typeof value === 'boolean'
    ? t(value ? 'yes' : 'no')
    : change.code === 'mode' ? valueLabel(t, 'mode', String(value)) : String(value)
  return t(`change.${change.code}`,
    { items: (change.items ?? []).map(item => source?.labels[item] ?? item).join(t('listSeparator')),
    from: shown(change.from), to: shown(change.to), name: change.name ?? '', source: source ? localized(t, source.title)
      : change.source ?? '',
    field: field ? localized(t, field.label) : change.field ?? '' })
}
/**
 * Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
 * Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
 */
export function ConfigHistory({ blocks, versions, focus }: { blocks: string[]; versions?: boolean; focus?: string }) {
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const { sources } = settings
  const [open, setOpen] = useState(!!focus)
  const [data, setData] = useState<HistoryView>()
  const [error, setError] = useState<string>()
  const revisions = JSON.stringify([Object.values(settings.blocks).map(block => block.revision), sources.map(source => source.revision)])
  useEffect(() => { if (open) call('GET policy/history').then(setData, failure => setError(errorText(failure))) }, [open, call, revisions])
  const listed = (block: string | undefined) => block ? blocks.some(item => item === block || (item.endsWith(':')
    && block.startsWith(item))) : blocks.includes('policy')
  const items = data?.items.filter(item => (versions && item.policyChanged) || listed(item.block)) ?? []
  // Match the oldest save that produced the focused Policy version (where that version originated).
  const target = focus ? items.filter(item => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1) : undefined
  const scroll = (element: HTMLLIElement | null) => { if (element
    && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) } }
  return <DisclosureRow icon={<Icon name="history" />} title={t('configHistory')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      {error && <p className="dt-error">{error}</p>}
      {data && <>
        <Hint>{t('historyIntro')}</Hint>
        {focus && !target && <Hint>{t('policyVersionUnrecorded', { version: focus.slice(0, 8) })}</Hint>}
        {items.length ? <ul className="dt-timeline">{items.map(item => <li key={item.revision} className={item === target
          ? 'dt-event dt-highlight' : 'dt-event'}
          ref={item === target ? scroll : undefined}>
          <div className="dt-row-title">{t('historyItem', { revision: item.revision, source: valueLabel(t, 'historySource',
            item.source) })}</div>
          <div className="dt-event-foot">{when(item.savedAt, t('lang'))}{item.policyChanged && <> · {t('historyPolicyChanged',
            { version: item.policyVersion.slice(0, 8) })}</>}</div>
          {item.changes === null ? <Hint>{t('historyNoBaseline')}</Hint> : item.changes.length
            ? <ul className="dt-changes">{item.changes.map((change, index) => <li key={index}>{changeText(t, change, sources)}</li>)}</ul>
              : <Hint>{t('historyNoChanges')}</Hint>}
          {item.notified.length > 0 && <Hint>{t('historyNotified', { count: item.notified.length,
            titles: item.notified.map(ticket => ticket.title).join(t('listSeparator')) })}</Hint>}
        </li>)}</ul> : <Hint>{t('historyEmpty')}</Hint>}
      </>}
    </div>
  </DisclosureRow>
}

type Row = Record<string, unknown>
type Column = Extract<FieldSpec, { type: 'rows' }>['columns'][number]
const ROWS_SHOWN = 6
const byName = ([, a]: [string, string], [, b]: [string, string]) => a.localeCompare(b)
type ScheduleValue = { kind: 'daily' | 'weekly' | 'every'; at?: string; weekday?: number; hours?: number }
/** The schedule a row holds, normalized so a row added a moment ago already shows usable controls. */
function asSchedule(value: unknown): ScheduleValue {
  const record = value && typeof value === 'object' ? value as Partial<ScheduleValue> : {}
  if (record.kind === 'weekly') return { kind: 'weekly', weekday: record.weekday ?? 1, at: record.at ?? '09:30' }
  if (record.kind === 'every') return { kind: 'every', hours: record.hours ?? 12 }
  return { kind: 'daily', at: record.at ?? '09:30' }
}
/**
 * One job's schedule as three shapes rather than a cron string: daily at a wall-clock time, weekly on a weekday, or
 * every N hours. The fields shown follow the shape, so a wrong field name cannot silently never fire.
 */
function ScheduleInput({ value, onChange }: { value: unknown; onChange: (next: ScheduleValue) => void }) {
  const { t } = usePanel()
  const schedule = asSchedule(value)
  const kind = (next: ScheduleValue['kind']) => onChange(next === 'daily' ? { kind: next, at: schedule.at ?? '09:30' }
    : next === 'weekly' ? { kind: next, weekday: schedule.weekday ?? 1, at: schedule.at ?? '09:30' } : { kind: next, hours: schedule.hours ?? 12 })
  return <span className="dt-schedule">
    <select className="dt-select" aria-label={t('scheduleKind')} value={schedule.kind}
      onChange={event => kind(event.target.value as ScheduleValue['kind'])}>
      {(['daily', 'weekly', 'every'] as const).map(option => <option key={option} value={option}>{t(`scheduleKind.${option}`)}</option>)}
    </select>
    {schedule.kind === 'every'
      ? <span className="dt-schedule-every"><Input type="number" min={1} max={168} required aria-label={t('scheduleHours')}
        value={String(schedule.hours ?? '')} onChange={event => onChange({ ...schedule, hours: event.target.value === '' ? undefined
          : Number(event.target.value) })} /><span className="dt-hint">{t('scheduleHoursUnit')}</span></span>
      : <Input type="time" required aria-label={t('scheduleAt')} value={schedule.at ?? ''}
        onChange={event => onChange({ ...schedule, at: event.target.value })} />}
    {schedule.kind === 'weekly' && <select className="dt-select" aria-label={t('scheduleWeekday')} value={String(schedule.weekday ?? 1)}
      onChange={event => onChange({ ...schedule, weekday: Number(event.target.value) })}>
      {[1, 2, 3, 4, 5, 6, 7].map(day => <option key={day} value={day}>{valueLabel(t, 'weekday', String(day))}</option>)}
    </select>}
  </span>
}
function RowsField({ field, value, saved, onChange, labels, refreshLabels }: {
  field: Extract<FieldSpec, { type: 'rows' }>; value: unknown; saved: unknown; onChange: (next: unknown) => void; labels: Record<string,
    string>
  refreshLabels: (() => Promise<string[]>) | undefined
}) {
  const { t, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const refresh = useAction(async () => {
    try {
      const added = await refreshLabels!()
      notify(added.length ? t('labelsAdded', { names: added.join(t('listSeparator')) }) : t('labelsCurrent'))
    } catch (failure) { notify(t('labelsFailed', { error: errorText(failure) })) }
  })
  const label = localized(t, field.label), hint = localized(t, field.hint)
  const rows = Array.isArray(value) ? value as Row[] : []
  const set = (index: number, row: Row) => onChange(rows.map((item, position) => position === index ? row : item))
  const key = field.columns[0]!
  const savedKeys = new Set((Array.isArray(saved) ? saved as Row[] : []).map(row => String(row[key.key] ?? '')))
  const choose = key.type === 'text' && key.choose && Object.keys(labels).length ? localized(t, key.choose) : ''
  // Exclude options already selected in another row.
  const choices = (id: string) => Object.entries(labels).filter(([option]) => option === id
    || !rows.some(other => String(other[key.key] ?? '') === option)).sort(byName)
  const blank = Object.fromEntries(field.columns.map(column => [column.key, column.type === 'select' ? column.options[0]!.value
    : column.type === 'switch' ? (column.initial ?? false)
      : column.type === 'schedule' ? { kind: 'daily', at: '09:30' }
        : column.type === 'time' ? '09:30' : '']))
  // Summarize a row by its second column only when that column is free text (e.g., a display name), not a select option.
  const named = field.columns[1]?.type === 'text' ? field.columns[1] : undefined
  const rowName = (row: Row) => (named && typeof row[named.key] === 'string' ? row[named.key] as string : '')
    || labels[String(row[key.key] ?? '')] || String(row[key.key] ?? '')
  const cell = (row: Row, index: number, column: Column) => {
    const id = String(row[key.key] ?? ''), change = (next: unknown) => set(index, { ...row, [column.key]: next })
    if (column === key && column.type === 'text' && (savedKeys.has(id) || (!choose && labels[id]))) {
      return <span key={column.key} className={labels[id] ? 'dt-row-label' : 'dt-row-label dt-mono'} title={id}>{labels[id] ?? id}</span>
    }
    if (column === key && column.type === 'text' && choose) {
      return <select key={column.key} className="dt-select" aria-label={choose} required value={id}
        onChange={event => change(event.target.value)}>
        <option value="" disabled>{choose}</option>
        {choices(id).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
      </select>
    }
    if (column !== key && column.type === 'text' && column.choose && Object.keys(labels).length) {
      // Unlike the key column, the same chat may be chosen by several rows, so every label stays offered.
      const current = String(row[column.key] ?? '')
      return <select key={column.key} className="dt-select" aria-label={localized(t, column.choose)} value={current}
        onChange={event => change(event.target.value)}>
        <option value="">{localized(t, column.choose)}</option>
        {current && !labels[current] ? <option value={current}>{current}</option> : null}
        {Object.entries(labels).sort(byName).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
      </select>
    }
    if (column.type === 'select') {
      return <select key={column.key} className="dt-select" aria-label={localized(t, column.label)} value={String(row[column.key] ?? '')}
        onChange={event => change(event.target.value)}>
        {column.options.map(option => <option key={option.value} value={option.value}>{localized(t, option.label)}</option>)}
      </select>
    }
    if (column.type === 'switch') {
      return <Switch key={column.key} checked={row[column.key] === true} label={localized(t, column.label)}
        onChange={next => change(next)} />
    }
    if (column.type === 'time') {
      return <Input key={column.key} type="time" aria-label={localized(t, column.label)} required value={String(row[column.key] ?? '')}
        onChange={event => change(event.target.value)} />
    }
    if (column.type === 'schedule') {
      return <ScheduleInput key={column.key} value={row[column.key]} onChange={change} />
    }
    if (column.type === 'textarea') {
      return <textarea key={column.key} className="dt-textarea dt-rows-textarea" rows={2} aria-label={localized(t, column.label)}
        placeholder={localized(t, column.label)} required={!column.optional} maxLength={column.maxLength}
        value={String(row[column.key] ?? '')} onChange={event => change(event.target.value)} />
    }
    return <Input key={column.key} className={column.optional ? undefined : 'dt-mono'} aria-label={localized(t, column.label)}
      placeholder={localized(t, column.label)} maxLength={column.type === 'text' ? column.maxLength : undefined}
      required={!column.optional} pattern={column.type === 'text' ? column.pattern : undefined} spellCheck={false}
      value={String(row[column.key] ?? '')}
      onChange={event => change(event.target.value)} />
  }
  return <div className="dt-field">
    <div className="dt-subhead">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}<span className="dt-count">{rows.length || ''}</span></span>
      <span className="dt-subhead-actions">
        {key.type === 'text' && key.refresh && refreshLabels && <Button variant="ghost" size="sm" className={refresh.busy ? 'dt-btn-busy'
          : undefined} icon={<Icon name="refresh" />}
          disabled={refresh.busy} aria-busy={refresh.busy} onClick={() => { void refresh.run() }}>{localized(t, key.refresh)}</Button>}
        <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={() => { setOpen(true); onChange([...rows,
          blank]) }}>{t('addRow')}</Button>
      </span>
    </div>
    {rows.length > ROWS_SHOWN && <button type="button" className="dt-textlink dt-rows-summary" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      {open ? t('collapse') : rows.map(rowName).join(t('listSeparator'))}
    </button>}
    {(rows.length <= ROWS_SHOWN || open) && <ul className="dt-rows"
      style={{ ['--dt-columns' as string]: field.columns.length }}>{rows.map((row, index) => <li key={index} className="dt-rows-item">
      {field.columns.map(column => cell(row, index, column))}
      <Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={t('removeRow', { name: labels[String(row[key.key] ?? '')]
        || String(row[key.key] ?? '') || label })}
        onClick={() => onChange(rows.filter((_, position) => position !== index))} />
    </li>)}</ul>}
  </div>
}
export function SourceField({ field, value, saved, fact, onChange, labels, refreshLabels }: {
  field: FieldSpec; value: unknown; saved: unknown; fact: Localized | string | undefined; onChange: (next: unknown) => void
  labels: Record<string, string>
  refreshLabels?: () => Promise<string[]>
}) {
  const { t, navigate } = usePanel()
  const label = localized(t, field.label), hint = localized(t, field.hint)
  switch (field.type) {
    case 'switch': return <SwitchRow label={label} hint={hint} checked={value === true} onChange={onChange} />
    case 'select': return <Field label={label} hint={hint}>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={label} value={String(value ?? field.options[0]!.value)}
        options={field.options.map(option => ({ value: option.value, label: localized(t, option.label) }))} onChange={onChange} />
    </Field>
    case 'number': return <Field label={label} hint={hint}>
      <Input type="number" min={field.min} max={field.max} required value={String(value ?? '')}
        onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
    </Field>
    case 'time': return <Field label={label} hint={hint}>
      <Input type="time" required value={String(value ?? '')} onChange={event => onChange(event.target.value)} />
    </Field>
    case 'text': return <Field label={label} hint={hint} note={localized(t, fact)}>
      {field.choose && Object.keys(labels).length
        ? <select className="dt-select" value={String(value ?? '')} onChange={event => onChange(event.target.value)}>
          <option value="">{localized(t, field.choose)}</option>
          {value && !labels[String(value)] ? <option value={String(value)}>{String(value)}</option> : null}
          {Object.entries(labels).sort(byName).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
        </select>
        : <Input value={String(value ?? '')} readOnly={field.readonly} pattern={field.pattern} spellCheck={false}
          onChange={event => onChange(event.target.value)} />}
    </Field>
    case 'fact': return <div className="dt-field">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</span>
      <span className="dt-mono">{localized(t, fact) || t('empty')}</span>
      {field.settings && <small>
        <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute(field.settings!))}>{t(`openSettingsOf.${field.settings}`)}</button>
      </small>}
    </div>
    case 'rows': return <RowsField field={field} value={value} saved={saved} onChange={onChange} labels={labels}
      refreshLabels={refreshLabels} />
  }
}
