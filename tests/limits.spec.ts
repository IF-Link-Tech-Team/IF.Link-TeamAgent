/** Guards the single source of validation bounds: a panel control may not re-type a number the schema already enforces. */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client')
const sources = readdirSync(CLIENT, { recursive: true, encoding: 'utf8' }).filter(path => /\.tsx?$/.test(path))

it('takes every numeric input bound from LIMITS, never a literal', () => {
  const literals = sources.flatMap(path => [...readFileSync(join(CLIENT, path), 'utf8').matchAll(/\b(?:min|max)=\{\d+\}/g)]
    .map(match => `src/client/${path}: ${match[0]}`))
  expect(literals).toEqual([])
})
