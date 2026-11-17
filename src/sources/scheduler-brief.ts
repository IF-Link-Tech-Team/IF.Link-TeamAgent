/**
 * The team memory as a heartbeat sees it: the draft folder, the dated lines of `PROJECTS.md`, and when the memory last changed.
 *
 * The Scheduler owns time; this module owns the shapes of the files it reads. Keeping them apart means a change to the
 * draft or project format does not touch the clock, and the clock can be tested without a memory directory at all.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dueDay, type ChecklistDraft, type ChecklistFollow } from './scheduler-job.ts'

/** The lines of the section whose heading contains `heading`, without bullets or blank entries. */
function sectionOf(body: string, heading: string): string[] {
  const pattern = new RegExp(`##\\s*[^\\n]*${heading}[^\\n]*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`)
  return (pattern.exec(body)?.[1] ?? '').split('\n')
    .map(text => text.replace(/^[-*\s]+/, '').trim())
    .filter(text => text.length > 0)
}

/** The part of a draft nobody has decided, which is one part a heartbeat needs to know about. */
const unresolvedOf = (body: string): string | undefined => sectionOf(body, '没解决')[0]?.slice(0, 80)

/** The follow-ups a draft promises, each with the day it comes due; a line with no day is dropped, not shown forever. */
const followsOf = (body: string, now: number, timeZone: string): ChecklistFollow[] =>
  sectionOf(body, '要回来跟进').flatMap(line => {
    const due = dueDay(line, now, timeZone)
    return due ? [{ due, what: line.replace(/^\d{4}-\d{1,2}-\d{1,2}\s*/, '').slice(0, 60) }] : []
  })

/**
 * The drafts waiting for Dreaming: what nobody has decided, the follow-ups they promise, and when the folder last
 * changed. A missing folder is not an error, just no drafts.
 */
export async function draftEntries(memoryDir: string, now: number, timeZone: string):
Promise<{ entries: ChecklistDraft[]; follows: ChecklistFollow[]; mtime?: number | undefined }> {
  const dir = join(memoryDir, 'drafts', 'inbox')
  const mtime = await stat(dir).then(found => found.mtimeMs).catch(() => undefined)
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.md') && !name.startsWith('_')).slice(0, 5)
  const entries: ChecklistDraft[] = []
  const follows: ChecklistFollow[] = []
  for (const name of names) {
    const body = await readFile(join(dir, name), 'utf8').catch(() => '')
    entries.push({ name: name.replace(/\.md$/, '').replace(/^[0-9a-f]{8}-/, ''), unresolved: unresolvedOf(body) })
    follows.push(...followsOf(body, now, timeZone))
  }
  return { entries, follows, mtime }
}

/** PROJECTS.md as stored, or empty when the deployment keeps none; only its dated lines reach a card. */
export async function projectNotes(memoryDir: string): Promise<string> {
  return readFile(join(memoryDir, 'PROJECTS.md'), 'utf8').catch(() => '')
}

/** When the team memory last changed, or undefined when none of its files exist. */
export async function memoryMtime(memoryDir: string): Promise<number | undefined> {
  const stamps = await Promise.all(['TEAM.md', 'PROJECTS.md', 'HEADINGS.md']
    .map(name => stat(join(memoryDir, name)).then(found => found.mtimeMs).catch(() => 0)))
  const newest = Math.max(0, ...stamps)
  return newest > 0 ? newest : undefined
}
