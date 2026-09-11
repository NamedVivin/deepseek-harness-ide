import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-ide-app bundle', () => {
  it('publishes the bounded file service and IDE Client rows through its patch manifest', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('ide-app patch must be a patch list')
    const rows = parsed.flatMap((entry): Record<string, unknown>[] =>
      typeof entry === 'object' && entry !== null
        ? (entry as { insert?: Record<string, unknown>[] }).insert ?? []
        : [])
    expect(rows).toEqual([
      {
        id: 'workspace-files',
        name: '@deepseek-ai/dsh-api-workspace-files',
        config: { maxTextFileBytes: 10 * 1024 * 1024, maxDirectoryEntries: 10_000 },
      },
      {
        id: 'ui-ide',
        name: '@deepseek-ai/dsh-client-ui-ide',
      },
    ])
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-api-workspace-files')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-client-ui-ide')
  })
})
