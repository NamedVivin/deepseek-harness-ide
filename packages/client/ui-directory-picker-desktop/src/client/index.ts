/** Desktop directory-flow Client contribution. */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DesktopDirectoryFlow, type DesktopFlowInjected } from './flow.ts'

export { DesktopDirectoryFlow } from './flow.ts'
export type { DesktopFlowInjected } from './flow.ts'

/** Required generated Remote and slot services. */
export const inject = ['slots', 'remote', 'remote.workspaceRegistration']

/**
 * Fill both workspace directory-flow holes with Host-owned registration.
 * @param ctx - Client root carrying slots and generated Remote contributions.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): DesktopFlowInjected => ({
    pickAndRegister: async (signal) => {
      const response = await ctx.remote.workspaceRegistration.pickAndRegister(signal)
      if (!response.ok) {
        throw new Error(
          `workspaceRegistration.pickAndRegister failed: ${response.error.code}: ${response.error.message}`,
        )
      }
      return response.value
    },
  })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow',
        inject: injected,
      }, DesktopDirectoryFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow',
        inject: injected,
      }, DesktopDirectoryFlow)
    }))
}
