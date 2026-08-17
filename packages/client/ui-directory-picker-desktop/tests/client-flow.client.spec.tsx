// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DesktopDirectoryFlow } from '../src/client/flow.ts'

function owner(overrides: Partial<DirectoryFlowOwnerProps> = {}): DirectoryFlowOwnerProps {
  return {
    open: true,
    busy: false,
    onPicked: vi.fn(),
    onRegistered: vi.fn(),
    onCancel: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}

describe('DesktopDirectoryFlow', () => {
  it('reports the Host-registered Workspace without a path-adoption callback', async () => {
    const props = owner()
    const workspace = {
      workspaceId: 'workspace-1' as never,
      path: '/projects/one',
      title: 'one',
      sessionIds: [],
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    }
    render(<DesktopDirectoryFlow {...props} pickAndRegister={async () => ({
      ok: true,
      value: { workspace },
    })} />)

    await vi.waitFor(() => { expect(props.onRegistered).toHaveBeenCalledWith(workspace) })
    expect(props.onPicked).not.toHaveBeenCalled()
  })

  it('maps chooser cancellation and aborts a request on close', async () => {
    const cancelled = owner()
    const first = render(<DesktopDirectoryFlow {...cancelled} pickAndRegister={async () => ({
      ok: false,
      error: { code: 'cancelled', message: 'cancelled' },
    })} />)
    await vi.waitFor(() => { expect(cancelled.onCancel).toHaveBeenCalledOnce() })
    first.unmount()

    let observed: AbortSignal | undefined
    const pending = owner()
    const second = render(<DesktopDirectoryFlow {...pending} pickAndRegister={(signal) => {
      observed = signal
      return new Promise(() => {})
    }} />)
    second.rerender(<DesktopDirectoryFlow {...pending} open={false} pickAndRegister={(signal) => {
      observed = signal
      return new Promise(() => {})
    }} />)
    expect(observed?.aborted).toBe(true)
  })

  it('reports stable Host failures through the owner error surface', async () => {
    const props = owner()
    render(<DesktopDirectoryFlow {...props} pickAndRegister={async () => ({
      ok: false,
      error: { code: 'picker-unavailable', message: 'native picker unavailable' },
    })} />)
    await vi.waitFor(() => { expect(props.onError).toHaveBeenCalledWith('native picker unavailable') })
  })
})
