/** Electron main entry: signed resources, pure-Node guardian, secure window, and bounded teardown. */

import { fork, spawn, type ForkOptions } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import {
  app,
  BrowserWindow,
  dialog,
  MessageChannelMain,
  protocol,
  session,
  type Event as ElectronEvent,
} from 'electron'
import { DesktopMainIpcPeer } from '@deepseek-ai/dsh-client-connection-desktop/adapter'
import type {
  DesktopMainMessageEndpoint,
  DesktopPortHandoff,
} from '@deepseek-ai/dsh-client-connection-desktop/protocol'
import {
  createElectronMainPortEndpoint,
  DesktopMainRendererPortBridge,
} from './electron-port-bridge.ts'
import {
  desktopGuardianArguments,
  desktopGuardianStdio,
  isDesktopConnectionOutboundMessage,
  resolveDesktopRuntimePaths,
  scrubDesktopRuntimeEnvironment,
} from './main-runtime.ts'
import { DesktopGuardianMainOwner } from './guardian-control.ts'
import {
  createDesktopJsonMainEndpoint,
  DESKTOP_PARENT_IPC_SERIALIZATION,
} from './parent-ipc.ts'
import { DESKTOP_PORT_CHANNEL } from './preload-api.ts'
import { handleDesktopProtocolRequest } from './protocol-handler.ts'
import {
  parseDesktopAssetManifest,
  validateDesktopClientAssets,
  verifyDesktopAssets,
} from './resource-manifest.ts'
import { parseDesktopRuntimeConfig } from './runtime-config.ts'
import { DesktopRuntimeSupervisor } from './runtime-supervisor.ts'
import {
  assertTrustedDesktopSender,
  DESKTOP_DOCUMENT_URL,
  isAllowedDesktopNavigation,
} from './security.ts'
import { parseSquirrelLifecycle, runSquirrelLifecycle } from './squirrel.ts'

protocol.registerSchemesAsPrivileged([{
  scheme: 'dsh-app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}])

let emergencyShutdown: (() => Promise<void>) | undefined

function runBoundedCommand(executable: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`desktop Squirrel: Update.exe exceeded ${String(timeoutMs)} ms`))
    }, timeoutMs)
    timer.unref()
    child.once('error', (error) => { finish(error) })
    child.once('exit', (code, signal) => {
      if (code === 0) finish()
      else finish(new Error(
        `desktop Squirrel: Update.exe ended by ${code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`}`,
      ))
    })
  })
}

function connectionEndpoint(
  raw: DesktopMainMessageEndpoint,
): DesktopMainMessageEndpoint {
  return {
    send: (frame) => { raw.send(frame) },
    onMessage: listener => raw.onMessage((value) => {
      if (isDesktopConnectionOutboundMessage(value)) listener(value)
    }),
    onDisconnect: listener => raw.onDisconnect(listener),
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function main(): Promise<void> {
  const paths = resolveDesktopRuntimePaths({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    platform: process.platform,
  })
  const config = parseDesktopRuntimeConfig(await readJson(paths.runtimeConfig))
  const squirrel = process.platform === 'win32' ? parseSquirrelLifecycle(process.argv) : undefined
  if (squirrel !== undefined) {
    await runSquirrelLifecycle(squirrel, process.execPath, config.squirrelTimeoutMs, runBoundedCommand)
    app.exit(0)
    return
  }

  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }
  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId('ai.deepseek.harness.ide')

  const manifest = parseDesktopAssetManifest(await readJson(paths.resourceManifest))
  const assets = await verifyDesktopAssets(paths.assets, manifest)
  const guardianForkOptions = {
    cwd: paths.host,
    execPath: paths.node,
    execArgv: [],
    env: scrubDesktopRuntimeEnvironment(process.env),
    serialization: DESKTOP_PARENT_IPC_SERIALIZATION,
    stdio: desktopGuardianStdio(process.platform),
    windowsHide: true,
  } satisfies ForkOptions & { readonly windowsHide: true }
  const guardian = fork(
    paths.guardian,
    desktopGuardianArguments(paths, config, process.platform),
    guardianForkOptions,
  )
  const guardianOwner = new DesktopGuardianMainOwner(guardian, {
    gracefulShutdownMs: config.gracefulShutdownMs,
    forceShutdownMs: config.forceShutdownMs,
    nativeProcessPollMs: config.nativeProcessPollMs,
    platform: process.platform,
  })
  guardian.stdout?.on('data', (chunk) => { process.stdout.write(chunk as Uint8Array) })
  guardian.stderr?.on('data', (chunk) => { process.stderr.write(chunk as Uint8Array) })
  const supervisor = new DesktopRuntimeSupervisor(guardian, config)
  const emergencyState: { peer?: DesktopMainIpcPeer | undefined } = {}
  emergencyShutdown = async () => {
    guardianOwner.prepareShutdown()
    await emergencyState.peer?.dispose().catch(() => {})
    await supervisor.shutdown('startup-abort').catch(() => {})
    await guardianOwner.dispose().catch(() => {})
  }

  const windowState: { main?: BrowserWindow | undefined } = {}
  const limits = {
    maxDesktopBodyBytes: config.maxDesktopBodyBytes,
    maxDesktopChunkBytes: config.maxDesktopChunkBytes,
    maxDesktopInflightBytes: config.maxDesktopInflightBytes,
  }
  const peer = new DesktopMainIpcPeer(
    connectionEndpoint(createDesktopJsonMainEndpoint(
      guardian as unknown as Parameters<typeof createDesktopJsonMainEndpoint>[0],
      config.maxDesktopChunkBytes,
    )),
    {
      'directory.pick': async (_payload, signal) => {
        throwIfAborted(signal)
        const window = windowState.main
        if (window === undefined || window.isDestroyed()) return { path: null }
        const result = await dialog.showOpenDialog(window, {
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose a workspace folder',
        })
        throwIfAborted(signal)
        return { path: result.canceled ? null : result.filePaths[0] ?? null }
      },
    },
    limits,
  )
  emergencyState.peer = peer

  let graph
  try {
    graph = await Promise.race([
      supervisor.start(),
      guardianOwner.failure.then(error => Promise.reject(error)),
    ])
  } catch (error) {
    guardianOwner.prepareShutdown()
    const cleanupFailures: unknown[] = []
    try {
      await peer.dispose()
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    try {
      await supervisor.shutdown('startup-abort')
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    try {
      await guardianOwner.dispose()
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'desktop startup and cleanup failed')
    }
    throw error
  }
  const activeClientUrls = validateDesktopClientAssets(assets, graph)
  protocol.handle('dsh-app', request => handleDesktopProtocolRequest(
    assets,
    activeClientUrls,
    request.url,
  ))

  const defaultSession = session.defaultSession
  defaultSession.setPermissionCheckHandler(() => false)
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
  defaultSession.webRequest.onBeforeRequest({
    urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'],
  }, (_details, callback) => { callback({ cancel: true }) })

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1117',
    title: 'DeepSeek Harness IDE',
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  })
  windowState.main = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-attach-webview', (event) => { event.preventDefault() })
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedDesktopNavigation(url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedDesktopNavigation(url)) event.preventDefault()
  })

  const channel = new MessageChannelMain()
  const rendererBridge = new DesktopMainRendererPortBridge(
    createElectronMainPortEndpoint(channel.port1),
    peer,
    limits,
  )
  const handoff: DesktopPortHandoff = { version: 1, limits }
  window.webContents.once('did-finish-load', () => {
    if (window.isDestroyed()) {
      channel.port2.close()
      return
    }
    assertTrustedDesktopSender(window.webContents.getURL())
    window.webContents.postMessage(DESKTOP_PORT_CHANNEL, handoff, [channel.port2])
  })
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })

  let shutdownTask: Promise<void> | undefined
  let quitRequest: Promise<void> | undefined
  const shutdown = (reason: 'app-quit' | 'main-disconnect'): Promise<void> => {
    shutdownTask ??= (async () => {
      guardianOwner.prepareShutdown()
      if (!window.isDestroyed()) window.destroy()
      await rendererBridge.dispose()
      await peer.dispose()
      await supervisor.shutdown(reason)
      await guardianOwner.dispose()
      emergencyShutdown = undefined
      app.exit(0)
    })()
    return shutdownTask
  }
  const requestQuit = (
    reason: 'window-close' | 'application-quit' | 'application-replace',
  ): Promise<void> => {
    if (shutdownTask !== undefined) return shutdownTask
    quitRequest ??= rendererBridge.request('desktop.prepareQuit', { reason }).then(
      result => result.ready ? shutdown('app-quit') : undefined,
      () => shutdown('main-disconnect'),
    ).finally(() => { quitRequest = undefined })
    return quitRequest
  }
  guardianOwner.onFailure(() => { void shutdown('main-disconnect') })

  window.on('close', (event: ElectronEvent) => {
    if (shutdownTask !== undefined) return
    event.preventDefault()
    void requestQuit('window-close')
  })
  window.webContents.on('render-process-gone', () => { void shutdown('main-disconnect') })
  window.on('unresponsive', () => { void shutdown('main-disconnect') })
  app.on('before-quit', (event) => {
    if (shutdownTask !== undefined) return
    event.preventDefault()
    void requestQuit('application-quit')
  })
  app.on('second-instance', () => {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  process.once('SIGTERM', () => { void shutdown('main-disconnect') })
  process.once('SIGINT', () => { void shutdown('main-disconnect') })

  await window.loadURL(DESKTOP_DOCUMENT_URL)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('desktop main operation aborted')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

void main().catch(async (error: unknown) => {
  await emergencyShutdown?.()
  emergencyShutdown = undefined
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  dialog.showErrorBox('DeepSeek Harness IDE could not start', message)
  process.stderr.write(`${message}\n`)
  app.exit(1)
})
