// Minimal CDP (Chrome DevTools Protocol) client over the built-in WebSocket.
// No third-party dependency: node 22+ ships a global WebSocket, and the
// protocol is plain JSON-RPC over a single socket per target.
//
// We attach to an already-running Chrome that was started with
// --remote-debugging-port, rather than launching our own. That keeps the
// user's real profile, cookies and logins intact, which is the whole point of
// driving a browser instead of fetching HTML.

const CDP_TIMEOUT_MS = 30_000

export class CdpError extends Error {
  constructor(method, message, details) {
    super(message)
    this.name = 'CdpError'
    this.method = method
    this.details = details
  }
}

/** Fetch the DevTools target list from a Chrome debug endpoint. */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!res.ok) throw new Error(`DevTools endpoint returned HTTP ${res.status}`)
  return await res.json()
}

export async function browserVersion(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`)
  if (!res.ok) throw new Error(`DevTools endpoint returned HTTP ${res.status}`)
  return await res.json()
}

/**
 * One CDP connection to a single page target.
 *
 * Chrome routes commands per-target: `/devtools/page/<id>` speaks the page
 * domain. Commands are correlated by an incrementing id; events arrive on the
 * same socket and are dispatched to whoever subscribed.
 */
export class CdpSession {
  #ws
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #closed = false

  constructor(ws) {
    this.#ws = ws
    ws.addEventListener('message', (event) => this.#onMessage(event.data))
    ws.addEventListener('close', () => {
      this.#closed = true
      // Reject in-flight work instead of leaving callers hanging forever.
      for (const [, entry] of this.#pending) {
        entry.reject(new CdpError(entry.method, 'CDP socket closed before reply'))
      }
      this.#pending.clear()
    })
    ws.addEventListener('error', () => {
      this.#closed = true
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timed out')), CDP_TIMEOUT_MS)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')) }, { once: true })
    })
    return new CdpSession(ws)
  }

  get closed() {
    return this.#closed
  }

  #onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const entry = this.#pending.get(msg.id)
      if (!entry) return
      this.#pending.delete(msg.id)
      if (msg.error) {
        entry.reject(new CdpError(entry.method, msg.error.message ?? 'CDP error', msg.error))
      } else {
        entry.resolve(msg.result)
      }
      return
    }
    if (msg.method) {
      const subs = this.#listeners.get(msg.method)
      if (subs) for (const fn of subs) {
        try { fn(msg.params) } catch { /* a listener must not kill the socket */ }
      }
      const wildcard = this.#listeners.get('*')
      if (wildcard) for (const fn of wildcard) {
        try { fn(msg) } catch { /* ignore */ }
      }
    }
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method, fn) {
    let subs = this.#listeners.get(method)
    if (!subs) { subs = new Set(); this.#listeners.set(method, subs) }
    subs.add(fn)
    return () => subs.delete(fn)
  }

  /** Resolve with the next occurrence of an event, or reject on timeout. */
  once(method, timeoutMs = CDP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        clearTimeout(timer)
        off()
        resolve(params)
      })
      const timer = setTimeout(() => {
        off()
        reject(new Error(`timed out waiting for ${method}`))
      }, timeoutMs)
    })
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.#closed) return Promise.reject(new CdpError(method, 'CDP session is closed'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(method, `CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        this.#ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new CdpError(method, `failed to send: ${error?.message ?? error}`))
      }
    })
  }

  close() {
    this.#closed = true
    try { this.#ws.close() } catch { /* already gone */ }
  }
}

/**
 * Open a CDP session for a page target, creating one if the browser has no
 * page yet. Chrome can be freshly started with zero tabs, in which case
 * /json/list is empty until something asks for a target.
 */
export async function openPageSession(port, { targetId } = {}) {
  let targets = await listTargets(port)
  let page = targetId
    ? targets.find((t) => t.id === targetId)
    : targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)

  if (!page) {
    // Ask the browser to create a blank tab, then re-list.
    const version = await browserVersion(port)
    const ws = await CdpSession.connect(version.webSocketDebuggerUrl)
    try {
      const created = await ws.send('Target.createTarget', { url: 'about:blank' })
      targets = await listTargets(port)
      page = targets.find((t) => t.id === created.targetId)
    } finally {
      ws.close()
    }
  }

  if (!page?.webSocketDebuggerUrl) {
    throw new Error('no page target available; is Chrome running with --remote-debugging-port?')
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl)
  return { session, target: page }
}
