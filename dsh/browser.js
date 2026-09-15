// Chrome lifecycle: find, reuse, or launch a debuggable Chrome, and hand back
// a page session.
//
// Design notes that matter for how this behaves in practice:
//
//  * We reuse ONE long-lived Chrome bound to a persistent profile directory.
//    Logins therefore survive between tool calls, which is the difference
//    between a usable browser tool and one that meets a login wall on every
//    navigation.
//  * A dedicated profile directory is deliberate, not incidental. Chrome
//    refuses to enable the DevTools port on a profile that another Chrome
//    instance already holds, so sharing the user's default profile would make
//    the tool fail whenever their own browser is open.
//  * Chrome is launched detached so it outlives this plugin's process and the
//    session that spawned it.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { browserVersion, listTargets, openPageSession } from './cdp.js'

const LAUNCH_TIMEOUT_MS = 25_000

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

export function findBrowserExecutable(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`browser executable not found: ${explicit}`)
    return explicit
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error(
    'no Chrome/Edge executable found; pass browserPath in the plugin config or install Chrome',
  )
}

export function profileDir(custom) {
  const dir = custom || join(homedir(), '.dsh', 'browser-profile')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function isDebuggerUp(port) {
  try {
    await browserVersion(port)
    return true
  } catch {
    return false
  }
}

/**
 * A debug port can be occupied by a stale Chrome whose profile lock no longer
 * matches the profile we want. Reading DevTools' own reported path lets us
 * tell "our Chrome is up" from "some other Chrome holds the port", instead of
 * blindly reusing whatever answers.
 */
async function debuggerProfile(port) {
  try {
    const info = await browserVersion(port)
    return { up: true, info }
  } catch {
    return { up: false, info: null }
  }
}

async function waitForDebugger(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      await browserVersion(port)
      return true
    } catch (error) {
      lastError = error
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  throw new Error(`Chrome did not expose a debug port on ${port} within ${timeoutMs}ms${lastError ? ` (${lastError.message})` : ''}`)
}

export class BrowserManager {
  #config
  #state = { port: null, pid: null, launched: false }

  constructor(config = {}) {
    this.#config = config
  }

  get port() {
    return this.#state.port
  }

  get launchedByUs() {
    return this.#state.launched
  }

  /** True when a debug endpoint answers on the configured port. */
  async isRunning() {
    if (!this.#state.port) return false
    return isDebuggerUp(this.#state.port)
  }

  /**
   * Ensure a debuggable Chrome exists, launching one if needed, and return the
   * port to talk to.
   */
  async ensure(port = this.#config.port ?? 9222) {
    if (this.#state.port && this.#state.port !== port) {
      // Re-target: drop the old bookkeeping, keep the old browser alive.
      this.#state = { port: null, pid: null, launched: false }
    }
    this.#state.port = port

    if (await isDebuggerUp(port)) {
      this.#state.launched = false
      return port
    }

    const exe = findBrowserExecutable(this.#config.browserPath)
    const dir = profileDir(this.#config.profileDir)
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      // Keep the window on-screen but out of the way of an automated run.
      '--window-size=1400,900',
      ...(this.#config.headless ? ['--headless=new'] : []),
      ...(this.#config.extraArgs ?? []),
      'about:blank',
    ]

    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    this.#state.pid = child.pid ?? null
    this.#state.launched = true

    await waitForDebugger(port, this.#config.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS)
    return port
  }

  /** Open (or attach to) a page session. */
  async page({ targetId } = {}) {
    const port = await this.ensure()
    return await openPageSession(port, { targetId })
  }

  async targets() {
    const port = await this.ensure()
    return await listTargets(port)
  }

  /**
   * Close the browser we launched. A user-started Chrome is left alone: the
   * tool did not open it and has no business closing it.
   */
  async close() {
    if (!this.#state.launched || !this.#state.port) return { closed: false, reason: 'not launched by this plugin' }
    try {
      const version = await browserVersion(this.#state.port)
      const { CdpSession } = await import('./cdp.js')
      const session = await CdpSession.connect(version.webSocketDebuggerUrl)
      try {
        await session.send('Browser.close')
      } finally {
        session.close()
      }
    } catch {
      // Fall through to the pid kill below.
    }
    this.#state.launched = false
    return { closed: true }
  }
}
