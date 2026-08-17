/** Effect-scoped Client file-opening arbitration shared by conversation surfaces. */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { FileLocation } from '@deepseek-ai/dsh-tools'

/** One request to open a model-facing file location for a session. */
export interface FileOpenRequest {
  /** Session whose registered workspace supplies location authority. */
  readonly sessionId: SessionId
  /** Complete tool-presented location, including an optional 1-based line. */
  readonly location: FileLocation
}

/** A handler claims a location or delegates it to the next contribution. */
export type FileOpenResult = 'handled' | 'unhandled'

/** One asynchronous internal file-opening contribution. */
export type FileOpenHandler = (request: FileOpenRequest) => Promise<FileOpenResult>

interface LiveState {
  readonly handlers: FileOpenHandler[]
}

/** Ordered internal opener registry; the carrier fallback remains with the owner. */
export class ClientFileOpener extends Service {
  private readonly live: LiveState = { handlers: [] }

  /** @param ctx - owning Client context. */
  constructor(ctx: Context) {
    super(ctx, 'fileOpener')
  }

  /**
   * Register one internal opener in composition order.
   * @param handler - contribution that either handles or delegates a request.
   * @returns disposer bound to the caller's effect scope.
   */
  register(handler: FileOpenHandler): () => void {
    const dispose = this.ctx.effect(() => {
      this.live.handlers.push(handler)
      return () => {
        const index = this.live.handlers.indexOf(handler)
        if (index >= 0) this.live.handlers.splice(index, 1)
      }
    }, 'fileOpener.register()')
    return () => { void dispose() }
  }

  /**
   * Offer a location to internal handlers in registration order.
   * @param request - session-authorized model-facing location.
   * @returns `handled` at the first claim, otherwise `unhandled`.
   */
  async tryOpen(request: FileOpenRequest): Promise<FileOpenResult> {
    for (const handler of [...this.live.handlers]) {
      if (await handler(request) === 'handled') return 'handled'
    }
    return 'unhandled'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Internal Client file-opening arbiter. */
    fileOpener: ClientFileOpener
  }
}
