/** Ticket workspace preparation shared by every worker runtime: the directory, the team memory snapshot, and the prepare command. */
import { copyFile, mkdir, readdir, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Ticket } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Store } from '../app/store.ts'
import type { Variable } from '../app/execution-environment.ts'

/** How long a ticket's prepare command may run before its launch fails. */
export const PREPARE_TIMEOUT_MS = 10 * 60_000
/** The team memory files a ticket copies: its facts and conventions, not the folder's own guide or the review protocol. */
export const SNAPSHOT_FILES = ['TEAM.md', 'PROJECTS.md', 'PEOPLE.md'] as const

/**
 * Thrown when a ticket's workspace prepare command fails. It is not retried automatically because an existing directory
 * counts as prepared, so retrying would treat whatever the failed command left behind as a prepared workspace.
 */
export class PrepareFailed extends Error {}

/** Copy the team memory files into a ticket's `memory/`; a missing directory leaves it without one rather than failing its launch. */
export async function copyMemory(from: string, to: string): Promise<void> {
  const present = new Set(await readdir(from).catch(() => [] as string[]))
  const names = SNAPSHOT_FILES.filter(name => present.has(name))
  if (names.length === 0) return
  await mkdir(to, { recursive: true })
  await Promise.all(names.map(name => copyFile(join(from, name), join(to, name))))
}

/** What preparing a workspace needs from the Runtime. */
export interface WorkspaceDeps {
  readonly store: Pick<Store, 'settings'>
  readonly context: Pick<Context, 'subprocess'>
  readonly machine: Pick<Machine, 'memoryDir'>
  readonly lifetime: AbortSignal
  environment(ticket: Ticket): Variable[]
}

/**
 * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
 * execution environment variables, then verifies the directory as the worker sees it.
 * @throws PrepareFailed with the command's output when the prepare command fails.
 */
export async function prepareWorkspace(ticket: Ticket, host: WorkspaceDeps): Promise<void> {
  const directory = ticket.execution?.directory ?? ''
  await mkdir(dirname(directory), { recursive: true })
  const command = host.store.settings().executor.prepare.trim()
  const env = Object.fromEntries(host.environment(ticket).map(variable => [variable.key, variable.value]))
  const signal = AbortSignal.any([host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
  if (command) await runAsWorker(host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
    .catch(async (error: unknown) => {
      // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
      await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
      throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  await mkdir(directory, { recursive: true })
  await copyMemory(host.machine.memoryDir, join(directory, 'memory'))
  await verifyDirectory(directory, host.context.subprocess, host.lifetime)
}
