// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { IdeToggle } from '../src/client/IdeToggle.tsx'
import { createIdeStore } from '../src/client/store.ts'

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

describe('IDE sidebar toggle', () => {
  it('renders wide copy and toggles the shared visible state', () => {
    const store = createIdeStore().create()
    render(
      <IdeToggle
        wide
        useStore={selectorHook(store)}
        actions={store.actions}
        useSessions={(() => undefined) as never}
        useWorkspaces={(() => undefined) as never}
        t={key => key}
      />,
    )

    const button = screen.getByRole('button', { name: 'action.open' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('title')).toBeNull()
    expect(screen.getByText('action.open')).toBeTruthy()

    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'action.close' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('renders the compact action without row copy', () => {
    const store = createIdeStore().create()
    const view = render(
      <IdeToggle
        wide={false}
        useStore={selectorHook(store)}
        actions={store.actions}
        useSessions={(() => undefined) as never}
        useWorkspaces={(() => undefined) as never}
        t={key => key}
      />,
    )

    const button = screen.getByRole('button', { name: 'action.open' })
    expect(button.getAttribute('title')).toBe('action.open')
    expect(view.container.querySelector('span')).toBeNull()
  })
})
