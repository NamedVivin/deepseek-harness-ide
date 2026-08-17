/**
 * One-shot Claude Code lifecycle: invoke the official Agent SDK, place its
 * real CLI process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/run
 */

import { randomUUID } from 'node:crypto'
import {
  query as officialQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  claudeSpawnSpec,
  ManagedClaudeCodeProcess,
} from './process.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/* jscpd:ignore-start -- sibling providers intentionally keep product-private
 * run inputs and error normalization instead of adding a shared lifecycle owner. */
/** Fully resolved inputs for one official Claude Agent SDK query. */
export interface ClaudeCodeRunSpec {
  /** Parent Session workspace supplied to the SDK and real CLI. */
  readonly cwd: string
  /** Exact native Claude Code executable resolved from the host PATH. */
  readonly executable: string
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => Promise<SubprocessHandle>
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/** Read abort state after asynchronous or re-entrant SDK work. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}
/* jscpd:ignore-end */

/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-claude-code: the one-shot task must not be empty')
  }
  return texts.join('')
}

/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - an official discriminated result union.
 * @returns exact final text for a successful, non-error result.
 */
export function successfulResult(message: SDKResultMessage): string {
  if (
    message.subtype !== 'success'
    || message.is_error
    || message.result.trim().length === 0
  ) {
    const detail = message.subtype === 'success'
      ? 'success result was marked as an error or contained no answer'
      : message.errors.join('; ') || message.subtype
    throw new Error(`subagent-claude-code: Claude Code failed: ${detail}`)
  }
  return message.result
}

/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion.
 * @param query - published official SDK query.
 * @returns the completed shared result.
 */
export async function consumeClaudeQuery(
  query: AsyncIterable<SDKMessage>,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const message of query) {
    if (message.type !== 'result') continue
    answer = successfulResult(message)
  }
  if (answer === undefined) {
    throw new Error('subagent-claude-code: Claude Code ended without a result')
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

/**
 * Close the official query, terminate the managed process tree, and wait for
 * the subprocess owner to prove it is gone.
 * @param query - official SDK query, when creation reached that point.
 * @param child - shared-service handle that owns the CLI process tree.
 */
export async function disposeClaudeCodeChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  try {
    query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  child.terminate()
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }
  try {
    await child.done
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'subagent-claude-code: query and process cleanup failed',
    )
  }
}

/**
 * Build the fixed official SDK options for one one-shot provider run.
 * @param spec - Workspace, environment, process service, and disposal policy.
 * @param controller - per-run cancellation owner.
 * @param spawnProcess - synchronous SDK hook backed by an already-ready managed child.
 * @param environment - stable SDK environment reused across request capture and launch.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
export function claudeQueryOptions(
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  spawnProcess: NonNullable<Options['spawnClaudeCodeProcess']>,
  environment: Record<string, string | undefined> = { ...scrubbedParentEnv(), ...spec.env },
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: spec.executable,
    env: { ...environment },
    persistSession: false,
    disallowedTools: ['AskUserQuestion'],
    spawnClaudeCodeProcess: spawnProcess,
  }
}

/** Compare the SDK-composed environment without depending on property order. */
function sameEnvironment(
  left: SpawnOptions['env'],
  right: SpawnOptions['env'],
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && left[key] === right[key]
    ))
}

/**
 * Require the real SDK query to request the exact process captured before the
 * asynchronous provider spawn. Forwarded signal identity is intentionally
 * excluded: each SDK transport owns a fresh post-grace signal, which is wired
 * to the already-created managed process separately.
 */
function assertSameSpawnOptions(expected: SpawnOptions, actual: SpawnOptions): void {
  const differences: string[] = []
  if (expected.command !== actual.command) differences.push('command')
  if (expected.cwd !== actual.cwd) differences.push('cwd')
  if (
    expected.args.length !== actual.args.length
    || expected.args.some((value: string, index: number) => value !== actual.args[index])
  ) differences.push('args')
  if (!sameEnvironment(expected.env, actual.env)) differences.push('env')
  if (differences.length > 0) {
    throw new Error(
      `subagent-claude-code: SDK spawn request changed between capture and launch (${differences.join(', ')})`,
    )
  }
}

/**
 * Ask the SDK to compose its private CLI request, then stop synchronously at
 * its custom-spawn hook before it creates a process or publishes a Query.
 */
function captureClaudeSpawnOptions(
  prompt: string,
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  environment: Record<string, string | undefined>,
): SpawnOptions {
  const capturedStop = new Error('subagent-claude-code: SDK spawn request captured')
  let captured: SpawnOptions | undefined
  let unexpectedQuery: Query | undefined
  try {
    unexpectedQuery = officialQuery({
      prompt,
      options: claudeQueryOptions(spec, controller, (options: SpawnOptions) => {
        captured = options
        throw capturedStop
      }, environment),
    })
  } catch (error: unknown) {
    if (error !== capturedStop) {
      throw new Error('subagent-claude-code: SDK spawn-request capture failed', {
        cause: thrown(error),
      })
    }
  }
  if (unexpectedQuery !== undefined) {
    const failure = new Error(
      'subagent-claude-code: SDK returned a Query after its spawn-request capture hook aborted creation',
    )
    try {
      unexpectedQuery.close()
    } catch (error: unknown) {
      throw new AggregateError(
        [failure, thrown(error)],
        'subagent-claude-code: invalid capture Query cleanup failed',
      )
    }
    throw failure
  }
  if (captured === undefined) {
    throw new Error('subagent-claude-code: SDK did not invoke its spawn-request capture hook')
  }
  return captured
}

/** Forward the real SDK transport's post-grace abort to its managed child. */
function forwardSdkAbort(child: SubprocessHandle, signal: AbortSignal): void {
  const terminate = (): void => { child.terminate() }
  if (signal.aborted) {
    terminate()
    return
  }
  signal.addEventListener('abort', terminate, { once: true })
  const remove = (): void => { signal.removeEventListener('abort', terminate) }
  void child.done.then(remove, remove)
}

/**
 * Start one official Claude Agent SDK query and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after both Query and real CLI handle exist.
 */
export async function startClaudeCodeRun(
  request: SubagentStartRequest,
  spec: ClaudeCodeRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-claude-code: request was aborted before SDK startup')
  }

  const controller = new AbortController()
  const setupController = new AbortController()
  let setupComplete = false
  const requestCancel = (): void => {
    const reason = new Error('subagent-claude-code: run cancelled locally')
    if (!setupComplete && !setupController.signal.aborted) {
      setupController.abort(reason)
    }
    if (!controller.signal.aborted) {
      controller.abort(reason)
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let child: SubprocessHandle | undefined
  let query: Query | undefined
  try {
    const environment = { ...scrubbedParentEnv(), ...spec.env }
    const captured = captureClaudeSpawnOptions(prompt, spec, controller, environment)
    if (isAborted(controller.signal)) {
      throw new Error('subagent-claude-code: SDK aborted while capturing its spawn request')
    }
    child = await spec.spawn(claudeSpawnSpec(
      captured,
      spec.disposeGraceMs,
      process.platform,
      setupController.signal,
    ))
    if (isAborted(controller.signal)) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new Error('subagent-claude-code: subprocess implementation dropped a piped SDK stream')
    }
    const readyChild = child
    let spawnHookCalls = 0
    query = officialQuery({
      prompt,
      options: claudeQueryOptions(spec, controller, (actual: SpawnOptions) => {
        spawnHookCalls += 1
        if (spawnHookCalls !== 1) {
          throw new Error('subagent-claude-code: SDK invoked its real spawn hook more than once')
        }
        assertSameSpawnOptions(captured, actual)
        forwardSdkAbort(readyChild, actual.signal)
        return new ManagedClaudeCodeProcess(readyChild)
      }, environment),
    })
    if (spawnHookCalls !== 1) {
      throw new Error(
        'subagent-claude-code: official SDK did not claim the ready Claude Code process',
      )
    }
    if (isAborted(controller.signal)) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    setupComplete = true
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeClaudeCodeChild(query, child)
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and CLI cleanup also failed',
        )
      }
    } else if (query !== undefined) {
      try {
        query.close()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and query cleanup also failed',
        )
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the request can abort while process cleanup is awaited.
    if (cancelledBeforeCleanup || request.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    throw thrown(error)
  }

  const publishedQuery = query
  const publishedChild = child
  const result = settleRunResult({
    attempt: () => consumeClaudeQuery(publishedQuery),
    collectOutput: () => [],
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeClaudeCodeChild(
      publishedQuery,
      publishedChild,
    ),
  })
}
