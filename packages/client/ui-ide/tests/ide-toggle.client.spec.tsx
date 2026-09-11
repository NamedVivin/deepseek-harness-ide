// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { IdeToggle } from '../src/client/IdeToggle.tsx'

afterEach(cleanup)

function selectorHook<T>(source: {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}): SnapshotSelectorHook<T> {
  return function useSelector<S>(selector: (state: T) => S): S {
    return selector(useSyncExternalStore(
      listener => source.subscribe(listener),
      () => source.getSnapshot(),
    ))
  }
}

describe('IDE conversation-header action', () => {
  it('renders an icon-only opener and reflects the layout column state', () => {
    let editorOpen = false
    const listeners = new Set<() => void>()
    const source = {
      getSnapshot: () => editorOpen,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const openEditor = () => {
      editorOpen = true
      for (const listener of listeners) listener()
    }
    const view = render(
      <IdeToggle
        useEditorOpen={selectorHook(source)}
        openEditor={openEditor}
        useSessions={(() => undefined) as never}
        useWorkspaces={(() => undefined) as never}
        t={key => key}
      />,
    )

    const button = screen.getByRole('button', { name: 'action.open' })
    expect(button.id).toBe('dsh-ide-toggle')
    expect(button.getAttribute('aria-controls')).toBe('dsh-ide-surface')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('title')).toBe('action.open')
    expect(view.container.querySelector('span')).toBeNull()

    fireEvent.click(button)
    const open = screen.getByRole('button', { name: 'action.open' }) as HTMLButtonElement
    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(open.getAttribute('title')).toBe('action.open')
    expect(open.disabled).toBe(true)
  })
})
