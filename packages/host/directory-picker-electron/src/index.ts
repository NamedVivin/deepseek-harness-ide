/**
 * Electron-main backend of the directory-picker seam. The Node sidecar asks
 * the separately authenticated Host-initiated desktop bridge to open a
 * chooser; no renderer method can request or receive the selected path.
 * @module @deepseek-ai/dsh-host-directory-picker-electron
 */

import { DirectoryPicker, type DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import type {} from '@deepseek-ai/dsh-client-connection-desktop'

/** Directory-picker provider forwarding each request to Electron main. */
export default class ElectronDirectoryPicker extends DirectoryPicker {
  static inject = ['desktopHostBridge']

  private readonly electronCapability: DirectoryPickerCapability = Object.freeze({
    kind: 'native' as const,
    pick: async (signal: AbortSignal): Promise<string | null> => {
      const response = await this.ctx.desktopHostBridge.request('directory.pick', {}, signal)
      signal.throwIfAborted()
      return response.path
    },
  })

  /**
   * Return the stable native interaction capability.
   * @returns the Electron-backed native capability.
   */
  capability(): DirectoryPickerCapability {
    return this.electronCapability
  }
}
