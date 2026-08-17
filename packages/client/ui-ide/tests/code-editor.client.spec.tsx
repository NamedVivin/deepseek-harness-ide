// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { CodeEditor } from '../src/client/CodeEditor.tsx'

afterEach(cleanup)

function mountedView(container: HTMLElement): EditorView {
  const editor = container.querySelector('.cm-editor') as HTMLElement | null
  const view = editor === null ? null : EditorView.findFromDOM(editor)
  if (view === null) throw new Error('CodeMirror view did not mount')
  return view
}

describe('IDE code editor', () => {
  it.each([
    ['script.js'],
    ['script.ts'],
    ['component.tsx'],
    ['data.json'],
    ['events.jsonl'],
    ['README.md'],
    ['style.css'],
    ['page.html'],
    ['fragment.htm'],
    ['tool.py'],
    ['LICENSE'],
  ])('mounts the language adapter for %s', async (name) => {
    const rendered = render(
      <CodeEditor
        value="text"
        path={[name]}
        label={name}
        focusRevision={0}
        onChange={() => {}}
      />,
    )
    expect(mountedView(rendered.container).contentDOM.getAttribute('aria-label')).toBe(name)
    await act(async () => { await Promise.resolve() })
  })

  it('mounts a path without a basename with the plain-text adapter', async () => {
    const rendered = render(
      <CodeEditor
        value="text"
        path={[]}
        label="untitled"
        focusRevision={0}
        onChange={() => {}}
      />,
    )
    expect(mountedView(rendered.container).state.doc.toString()).toBe('text')
    await act(async () => { await Promise.resolve() })
  })

  it('reports local edits through the latest callback and ignores controlled replacements', () => {
    const firstOnChange = vi.fn()
    const nextOnChange = vi.fn()
    const rendered = render(
      <CodeEditor
        value="alpha"
        path={['a.ts']}
        label="a.ts"
        focusRevision={0}
        onChange={firstOnChange}
      />,
    )
    const view = mountedView(rendered.container)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'beta' } })
    expect(firstOnChange).toHaveBeenCalledWith('beta')

    rendered.rerender(
      <CodeEditor
        value="beta"
        path={['a.ts']}
        label="a.ts"
        focusRevision={0}
        onChange={nextOnChange}
      />,
    )
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'local' } })
    expect(nextOnChange).toHaveBeenCalledWith('local')

    nextOnChange.mockClear()
    rendered.rerender(
      <CodeEditor
        value="external"
        path={['a.ts']}
        label="a.ts"
        focusRevision={0}
        onChange={nextOnChange}
      />,
    )
    expect(view.state.doc.toString()).toBe('external')
    expect(nextOnChange).not.toHaveBeenCalled()
  })

  it('clamps repeated line reveals to the controlled document', () => {
    const rendered = render(
      <CodeEditor
        value={'one\ntwo\nthree'}
        path={['a.ts']}
        label="a.ts"
        focusLine={99}
        focusRevision={1}
        onChange={() => {}}
      />,
    )
    const view = mountedView(rendered.container)
    expect(view.state.selection.main.anchor).toBe(view.state.doc.line(3).from)

    rendered.rerender(
      <CodeEditor
        value={'one\ntwo\nthree'}
        path={['a.ts']}
        label="a.ts"
        focusLine={0}
        focusRevision={2}
        onChange={() => {}}
      />,
    )
    expect(view.state.selection.main.anchor).toBe(view.state.doc.line(1).from)
  })

  it('destroys a replaced editor before its pending language activation', async () => {
    const rendered = render(
      <CodeEditor
        key="first"
        value="first"
        path={['first.ts']}
        label="first"
        focusRevision={0}
        onChange={() => {}}
      />,
    )
    const first = mountedView(rendered.container)
    rendered.rerender(
      <CodeEditor
        key="second"
        value="second"
        path={['second.ts']}
        label="second"
        focusRevision={0}
        onChange={() => {}}
      />,
    )
    expect(first.dom.isConnected).toBe(false)
    await act(async () => { await Promise.resolve() })
    expect(mountedView(rendered.container).state.doc.toString()).toBe('second')
  })
})
