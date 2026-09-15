// DeepSeek Harness plugin: real-browser automation.
//
// Why a browser at all, when the harness already has web_search and web_fetch:
// those read static HTML. A large share of what a user actually asks for lives
// behind JavaScript, an interaction, or a login — dashboards, docs behind a
// search box, anything rendered client-side. This plugin drives the user's own
// Chrome over the DevTools Protocol, so it sees the page after scripts run and
// keeps whatever sessions that profile already has.
//
// The model sees ONE tool, `browser`, with an action switch rather than a
// dozen near-identical tools. Browser work is a sequence of steps against
// shared state; one tool keeps the whole interaction inside a single
// conversation slot and lets each call return the observation the next call
// needs.

import { defineTool } from '@deepseek-ai/dsh-tools'
import { BrowserManager } from './browser.js'
import { PageActions } from './actions.js'

export const name = 'dsh-browser'
export const inject = ['tools']

const DEFAULT_MAX_CHARS = 12_000

const ACTIONS = [
  'launch', 'goto', 'observe', 'text', 'elements', 'links', 'screenshot',
  'click', 'type', 'key', 'scroll', 'evaluate', 'tabs', 'switch_tab',
  'new_tab', 'close_tab', 'close_browser', 'wait', 'back',
]

/** Sessions are keyed by target so tabs survive between tool calls. */
class SessionRegistry {
  #manager
  #sessions = new Map()
  #activeKey = null

  constructor(manager) {
    this.#manager = manager
  }

  get manager() { return this.#manager }

  async acquire({ targetId, newTab = false } = {}) {
    const port = await this.#manager.ensure()
    if (newTab) {
      const actions = await this.#openNewTab(port)
      this.#activeKey = actions.target.id
      this.#sessions.set(actions.target.id, actions)
      return actions
    }
    const key = targetId ?? this.#activeKey
    if (key && this.#sessions.has(key)) {
      const existing = this.#sessions.get(key)
      if (!existing.session.closed) {
        this.#activeKey = key
        return existing
      }
      this.#sessions.delete(key)
    }
    const actions = await this.#openOrReuse(port, targetId)
    this.#activeKey = actions.target.id
    this.#sessions.set(actions.target.id, actions)
    return actions
  }

  async #openNewTab(port) {
    const { CdpSession, listTargets, browserVersion } = await import('./cdp.js')
    const version = await browserVersion(port)
    const browser = await CdpSession.connect(version.webSocketDebuggerUrl)
    let targetId
    try {
      const created = await browser.send('Target.createTarget', { url: 'about:blank' })
      targetId = created.targetId
    } finally {
      browser.close()
    }
    const targets = await listTargets(port)
    const target = targets.find((t) => t.id === targetId) ?? targets.find((t) => t.type === 'page')
    if (!target?.webSocketDebuggerUrl) throw new Error('could not open a new browser tab')
    const session = await CdpSession.connect(target.webSocketDebuggerUrl)
    const actions = new PageActions(session, target)
    await actions.init()
    return actions
  }

  async #openOrReuse(port, targetId) {
    const { openPageSession } = await import('./cdp.js')
    const { session, target } = await openPageSession(port, { targetId })
    const actions = new PageActions(session, target)
    await actions.init()
    return actions
  }

  async list() {
    const targets = await this.#manager.targets()
    return targets
      .filter((t) => t.type === 'page')
      .map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.id === this.#activeKey }))
  }

  active() {
    if (!this.#activeKey) return null
    return this.#sessions.get(this.#activeKey) ?? null
  }

  async switchTo(targetId) {
    return await this.acquire({ targetId })
  }

  async closeTab(targetId) {
    const key = targetId ?? this.#activeKey
    if (!key) return { closed: false }
    const actions = this.#sessions.get(key)
    if (actions) {
      try { await actions.session.send('Page.close') } catch { /* already closing */ }
      actions.session.close()
      this.#sessions.delete(key)
    }
    if (this.#activeKey === key) this.#activeKey = null
    return { closed: true }
  }

  closeAll() {
    for (const [, actions] of this.#sessions) {
      try { actions.session.close() } catch { /* ignore */ }
    }
    this.#sessions.clear()
    this.#activeKey = null
  }
}

function apply(ctx, config = {}) {
  const manager = new BrowserManager(config)
  const registry = new SessionRegistry(manager)
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS

  const observe = async (page) => await page.observe({ maxChars })

  ctx.tools.register(defineTool({
    name: 'browser',
    description: [
      'Drive a real Chrome browser to read or interact with web pages.',
      '',
      'Use this instead of web_fetch when the page needs JavaScript to render,',
      'requires logging in, or when you must click or type to reach the content',
      '(search boxes, dashboards, paginated lists, forms).',
      '',
      'Typical loop: action="goto" a URL, action="observe" to read the page as',
      'text, action="click"/"type" to interact, then "observe" again. Use',
      'action="screenshot" when layout or imagery matters.',
      '',
      'The browser keeps a persistent profile, so logins survive across calls',
      'and sessions. If a site needs a human sign-in, ask the user to sign in',
      'once in the opened window, then continue.',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ACTIONS,
        description: 'Which browser operation to perform.',
      },
      url: { type: 'string', description: 'URL for goto/new_tab. Scheme optional (https:// assumed).' },
      selector: { type: 'string', description: 'CSS selector locating the target element (click/type/text/evaluate).' },
      text: { type: 'string', description: 'Visible text used to locate an element when byText is true.' },
      value: { type: 'string', description: 'The content to enter for action="type".' },
      byText: { type: 'boolean', description: 'Match the target by visible text instead of a CSS selector.' },
      key: { type: 'string', description: 'Key name for action="key": Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, PageUp, PageDown.' },
      expression: { type: 'string', description: 'JavaScript expression for action="evaluate"; its value is returned.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      clear: { type: 'boolean', description: 'Clear the field before typing.' },
      deltaY: { type: 'number', description: 'Vertical scroll in pixels (negative scrolls up). Default 600.' },
      fullPage: { type: 'boolean', description: 'Capture the entire page rather than the viewport.' },
      targetId: { type: 'string', description: 'Tab id from action="tabs", for switch_tab/close_tab.' },
      newTab: { type: 'boolean', description: 'Run this action in a new tab.' },
      maxChars: { type: 'number', description: 'Cap on returned page text. Default 12000.' },
      waitMs: { type: 'number', description: 'Milliseconds to wait (action="wait"), or the navigation timeout.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
          length: { type: 'number' },
          result: { type: 'string' },
          detail: { type: 'string' },
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                url: { type: 'string' },
                title: { type: 'string' },
                active: { type: 'boolean' },
              },
            },
          },
          image: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value?.image) {
          return [
            { type: 'text', text: `Screenshot of ${value.url ?? ''}` },
            { type: 'image', data: value.image, mimeType: 'image/png' },
          ]
        }
        if (value?.tabs) {
          const lines = value.tabs.map((t) => `${t.active ? '* ' : '  '}${t.id}\n    ${t.title || '(untitled)'}\n    ${t.url}`)
          return [{ type: 'text', text: lines.length ? lines.join('\n') : '(no open tabs)' }]
        }
        if (value?.result !== undefined) {
          return [{ type: 'text', text: typeof value.result === 'string' ? value.result : JSON.stringify(value.result, null, 2) }]
        }
        if (value?.detail !== undefined && value?.text === undefined) {
          return [{ type: 'text', text: value.detail }]
        }
        const parts = []
        if (value?.url) parts.push(`URL: ${value.url}`)
        if (value?.title) parts.push(`Title: ${value.title}`)
        if (value?.detail) parts.push(value.detail)
        if (value?.truncated) parts.push(`(text truncated; ${value.length} chars total)`)
        if (value?.text !== undefined) {
          parts.push('')
          parts.push(value.text || '(no readable text on the page)')
        }
        return [{ type: 'text', text: parts.join('\n') || 'done' }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = args?.action
      switch (action) {
        case 'launch': {
          const port = await manager.ensure()
          const tabs = await registry.list().catch(() => [])
          return {
            ok: true, action, url: '', tabs,
            detail: `Browser ready on debug port ${port} (${manager.launchedByUs ? 'launched' : 'reused existing'}).`,
          }
        }
        case 'goto': {
          if (!args.url) throw new Error('action="goto" requires a url')
          const page = await registry.acquire({ targetId: args.targetId, newTab: args.newTab === true })
          await page.goto(args.url, { waitMs: args.waitMs })
          return { ok: true, action, ...(await observe(page)) }
        }
        case 'observe': {
          const page = await registry.acquire({ targetId: args.targetId })
          return { ok: true, action, ...(await observe(page)) }
        }
        case 'text': {
          const page = await registry.acquire({ targetId: args.targetId })
          const result = await page.text({ maxChars, selector: args.selector ?? null })
          const url = await page.evaluate('location.href').catch(() => '')
          const title = await page.evaluate('document.title').catch(() => '')
          return { ok: true, action, url, title, ...result }
        }
        case 'elements': {
          const page = await registry.acquire({ targetId: args.targetId })
          const found = await page.elements()
          return {
            ok: true, action, url: page.currentUrl(), result: found,
            detail: `${found.length} interactive element(s) found.`,
          }
        }
        case 'links': {
          const page = await registry.acquire({ targetId: args.targetId })
          const found = await page.links()
          return { ok: true, action, url: page.currentUrl(), result: found }
        }
        case 'screenshot': {
          const page = await registry.acquire({ targetId: args.targetId })
          const shot = await page.screenshot({ fullPage: args.fullPage === true })
          return { ok: true, action, url: page.currentUrl(), image: shot.data }
        }
        case 'click': {
          const target = args.selector ?? (args.byText ? args.text : null)
          if (!target) throw new Error('action="click" requires a selector (or text with byText=true)')
          const page = await registry.acquire({ targetId: args.targetId })
          const hit = await page.click(target, { byText: args.byText === true })
          await page.waitForLoad().catch(() => {})
          return {
            ok: true, action, ...(await observe(page)),
            detail: `Clicked <${hit.tag}> "${hit.text}"`,
          }
        }
        case 'type': {
          const field = args.selector ?? (args.byText ? args.text : null)
          if (!field) throw new Error('action="type" requires a selector (or text with byText=true) for the field')
          if (args.value === undefined) throw new Error('action="type" requires a "value" containing the text to enter')
          const page = await registry.acquire({ targetId: args.targetId })
          const hit = await page.type(field, args.value, {
            byText: args.byText === true,
            clear: args.clear === true,
            submit: args.submit === true,
          })
          await page.waitForLoad().catch(() => {})
          return {
            ok: true, action, ...(await observe(page)),
            detail: `Typed into <${hit.tag}>${args.submit ? ' and pressed Enter' : ''}`,
          }
        }
        case 'key': {
          if (!args.key) throw new Error('action="key" requires a key name')
          const page = await registry.acquire({ targetId: args.targetId })
          await page.key(args.key)
          return { ok: true, action, ...(await observe(page)), detail: `Pressed ${args.key}` }
        }
        case 'scroll': {
          const page = await registry.acquire({ targetId: args.targetId })
          await page.scroll({ deltaY: args.deltaY ?? 600 })
          return { ok: true, action, ...(await observe(page)) }
        }
        case 'evaluate': {
          if (!args.expression) throw new Error('action="evaluate" requires an expression')
          const page = await registry.acquire({ targetId: args.targetId })
          const value = await page.evaluate(args.expression)
          return { ok: true, action, url: page.currentUrl(), result: value }
        }
        case 'tabs': {
          await manager.ensure()
          return { ok: true, action, url: '', tabs: await registry.list() }
        }
        case 'switch_tab': {
          if (!args.targetId) throw new Error('action="switch_tab" requires a targetId (see action="tabs")')
          const page = await registry.switchTo(args.targetId)
          return { ok: true, action, ...(await observe(page)) }
        }
        case 'new_tab': {
          const page = await registry.acquire({ newTab: true })
          if (args.url) await page.goto(args.url, { waitMs: args.waitMs })
          return { ok: true, action, ...(await observe(page)) }
        }
        case 'close_tab': {
          const result = await registry.closeTab(args.targetId)
          return { ok: true, action, url: '', detail: result.closed ? 'Tab closed.' : 'No tab to close.' }
        }
        case 'back': {
          const page = await registry.acquire({ targetId: args.targetId })
          await page.evaluate('history.back()')
          await page.waitForLoad().catch(() => {})
          return { ok: true, action, ...(await observe(page)) }
        }
        case 'wait': {
          const ms = Math.min(Number(args.waitMs ?? 1000), 60_000)
          await new Promise((r) => setTimeout(r, ms))
          const page = registry.active()
          if (!page) return { ok: true, action, url: '', detail: `Waited ${ms}ms (no page open).` }
          return { ok: true, action, ...(await observe(page)) }
        }
        case 'close_browser': {
          registry.closeAll()
          const result = await manager.close()
          return {
            ok: true, action, url: '',
            detail: result.closed ? 'Browser closed.' : `Browser left running (${result.reason ?? 'not launched by this plugin'}).`,
          }
        }
        default:
          throw new Error(`unknown action ${JSON.stringify(action)}; expected one of ${ACTIONS.join(', ')}`)
      }
    },
  }))

  // Sessions hold sockets; drop them when the plugin unloads.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => registry.closeAll())
  }
}

export { apply }
