/** CodeMirror 6 adapter kept private to the IDE presentation package. */

import { basicSetup } from 'codemirror'
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { css as cssLanguage } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import css from './CodeEditor.module.css'

const EXTERNAL_DOCUMENT = Annotation.define<boolean>()

function languageFor(path: readonly string[]): Promise<Extension> {
  const name = path.at(-1)?.toLowerCase() ?? ''
  if (/\.(?:js|jsx|mjs|cjs)$/.test(name)) return Promise.resolve(javascript({ jsx: true }))
  if (/\.(?:ts|tsx|mts|cts)$/.test(name)) return Promise.resolve(javascript({ typescript: true, jsx: name.endsWith('x') }))
  if (name.endsWith('.json') || name.endsWith('.jsonl')) return Promise.resolve(json())
  if (name.endsWith('.md') || name.endsWith('.mdown') || name.endsWith('.markdown')) return Promise.resolve(markdown())
  if (name.endsWith('.css')) return Promise.resolve(cssLanguage())
  if (name.endsWith('.html') || name.endsWith('.htm')) return Promise.resolve(html())
  if (name.endsWith('.py')) return Promise.resolve(python())
  return Promise.resolve([])
}

/**
 * Render one controlled CodeMirror document. Language parsers are selected and
 * activated only for the mounted file identity.
 * @param props.value - current in-memory buffer.
 * @param props.path - canonical relative identity used only for language choice.
 * @param props.label - accessible editor label.
 * @param props.focusLine - optional one-based reveal line.
 * @param props.focusRevision - reveal request account, including repeated requests for one line.
 * @param props.onChange - local document edit callback.
 * @returns CodeMirror mount element.
 */
export function CodeEditor({ value, path, label, focusLine, focusRevision, onChange }: {
  value: string
  path: readonly string[]
  label: string
  focusLine?: number
  focusRevision: number
  onChange: (value: string) => void
}) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const mount = mountRef.current as HTMLDivElement
    const language = new Compartment()
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return
          if (update.transactions.some(transaction => transaction.annotation(EXTERNAL_DOCUMENT) === true)) return
          onChangeRef.current(update.state.doc.toString())
        }),
        language.of([]),
      ],
    })
    const view = new EditorView({ state, parent: mount })
    viewRef.current = view
    let current = true
    void languageFor(path).then((extension) => {
      if (!current) return
      view.dispatch({ effects: language.reconfigure(extension) })
    })
    return () => {
      current = false
      viewRef.current = null
      view.destroy()
    }
    // A tab identity change remounts the adapter at the parent via `key`.
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === value) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: EXTERNAL_DOCUMENT.of(true),
    })
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || focusLine === undefined) return
    const lineNumber = Math.min(Math.max(1, focusLine), view.state.doc.lines)
    const line = view.state.doc.line(lineNumber)
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
  }, [focusLine, focusRevision])

  return <div ref={mountRef} className={css.editor} />
}
