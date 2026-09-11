/** Conversation-header action that opens the layout-owned editor column. */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './IdeToggle.module.css'

/** Registration-side layout face for the editor action. */
export interface IdeToggleInjected {
  hooks: {
    /** Layout open state bound by the renderer as useEditorOpen. */
    editorOpen: ObservableSnapshot<boolean>
  }
  /** Open the layout-owned editor column. */
  openEditor: () => void
}

/** Props composed from the header owner, layout face, and IDE dictionary. */
export type IdeToggleProps =
  PropsRuntime<'conversation.header.utilities'>
  & InjectFace<IdeToggleInjected>
  & PropsLocale<'ide'>

/** Render the conversation-header editor toggle. */
export function IdeToggle({ useEditorOpen, openEditor, t }: IdeToggleProps) {
  const editorOpen = useEditorOpen(value => value)
  return (
    <button
      id="dsh-ide-toggle"
      type="button"
      className={css.button}
      aria-label={t('action.open')}
      aria-controls="dsh-ide-surface"
      aria-expanded={editorOpen}
      title={t('action.open')}
      disabled={editorOpen}
      onClick={openEditor}
    >
      <IconCodeOutline16 />
    </button>
  )
}
