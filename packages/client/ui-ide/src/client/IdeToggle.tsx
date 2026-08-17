/** Sidebar footer action that toggles the shared IDE root store. */

import { IconCodeOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createIdeStore } from './store.ts'
import css from './IdeToggle.module.css'

/** Props composed from the sidebar owner, shared store, and IDE dictionary. */
export type IdeToggleProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createIdeStore>>
  & PropsLocale<'ide'>

/** Render the wide-row or compact-rail editor toggle. */
export function IdeToggle({ wide, useStore, actions, t }: IdeToggleProps) {
  const visible = useStore(state => state.visible)
  return (
    <button
      type="button"
      className={css.button}
      aria-label={visible ? t('action.close') : t('action.open')}
      aria-expanded={visible}
      title={wide ? undefined : t('action.open')}
      onClick={() => { actions.dispatch({ type: 'toggle-visible' }) }}
    >
      <IconCodeOutline16 />
      {wide && <span>{t('action.open')}</span>}
    </button>
  )
}
