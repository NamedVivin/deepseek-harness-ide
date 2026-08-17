/** Renderless desktop directory-flow occupant. */

import type { WorkspaceRegistrationResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ReactElement } from 'react'
import { useEffect, useRef } from 'react'

/** Generated Host operation used by the desktop flow. */
export interface DesktopFlowInjected {
  /** Open the Host-owned picker and register its selected directory. */
  pickAndRegister: (signal: AbortSignal) => Promise<WorkspaceRegistrationResult>
}

/**
 * Drive one cancellable Host registration for each rising `open` edge.
 * @param props - Directory-flow owner conversation and generated Remote call.
 * @returns no DOM; Electron owns the native chooser.
 */
export function DesktopDirectoryFlow(
  props: DirectoryFlowOwnerProps & DesktopFlowInjected,
): ReactElement | null {
  const { open, pickAndRegister } = props
  const outcome = useRef(props)
  outcome.current = props
  const controller = useRef<AbortController>()

  useEffect(() => {
    if (!open) {
      controller.current?.abort(new Error('directory flow closed'))
      controller.current = undefined
      return
    }
    if (controller.current !== undefined) return
    const request = new AbortController()
    controller.current = request
    void pickAndRegister(request.signal).then(
      (result) => {
        if (request.signal.aborted || controller.current !== request) return
        controller.current = undefined
        if (result.ok) {
          outcome.current.onRegistered(result.value.workspace)
        } else if (result.error.code === 'cancelled') {
          outcome.current.onCancel()
        } else {
          outcome.current.onError(result.error.message)
        }
      },
      (error: unknown) => {
        if (request.signal.aborted || controller.current !== request) return
        controller.current = undefined
        outcome.current.onError(error instanceof Error ? error.message : String(error))
      },
    )
    return () => {
      if (controller.current === request) controller.current = undefined
      request.abort(new Error('directory flow occupant disposed'))
    }
  }, [open, pickAndRegister])

  return null
}
