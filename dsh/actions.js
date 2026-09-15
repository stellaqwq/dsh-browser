// High-level page actions built on the CDP session: navigate, observe, click,
// type, scroll, and extract. Everything a browsing task actually needs, with
// the awkward protocol details (iframe-aware evaluation, waiting for load,
// resolving elements back to something clickable) handled in one place.

import { CdpSession } from './cdp.js'

const NAV_TIMEOUT_MS = 45_000
const DEFAULT_VIEWPORT = { width: 1400, height: 900 }

/** A helper evaluated in the page to resolve a selector or text into a point. */
const LOCATE_HELPER = `
function __dshResolve(target, byText) {
  if (!target) return null;
  let el = null;
  if (byText) {
    const want = String(target).trim().toLowerCase();
    const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[contenteditable=true],label,li,span,div,p,h1,h2,h3,td,th'));
    el = nodes.find(n => (n.innerText || n.textContent || '').trim().toLowerCase() === want)
      || nodes.find(n => (n.innerText || n.textContent || '').trim().toLowerCase().includes(want));
  } else {
    el = document.querySelector(target);
  }
  if (!el) return null;
  try { el.scrollIntoView({block:'center', inline:'center'}); } catch (e) {}
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
           tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 200) };
}
`

export class PageActions {
  #session
  #target
  #viewport

  constructor(session, target, viewport = DEFAULT_VIEWPORT) {
    this.#session = session
    this.#target = target
    this.#viewport = viewport
  }

  get session() { return this.#session }
  get target() { return this.#target }

  async init({ viewport } = {}) {
    const vp = viewport ?? this.#viewport
    this.#viewport = vp
    await this.#session.send('Page.enable')
    await this.#session.send('Runtime.enable')
    await this.#session.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false,
    })
    return this
  }

  currentUrl() {
    return this.#target?.url ?? 'about:blank'
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.#session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'page evaluation failed'
      throw new Error(desc)
    }
    return result.result?.value
  }

  async waitForLoad(timeoutMs = NAV_TIMEOUT_MS) {
    // 'Page.loadEventFired' may already have passed for a cached navigation, so
    // race it against document.readyState to avoid a needless full timeout.
    const ready = this.evaluate("document.readyState === 'complete' || document.readyState === 'interactive'")
      .catch(() => false)
    const fired = this.#session.once('Page.loadEventFired', timeoutMs).then(() => true).catch(() => false)
    await Promise.race([ready, fired])
    // Give late layout/JS a beat to settle; a snapshot taken too early is the
    // usual cause of "element not found" on otherwise fine pages.
    await new Promise((r) => setTimeout(r, 250))
  }

  async goto(url, { waitMs = NAV_TIMEOUT_MS } = {}) {
    if (!/^(https?|file|about|data):/i.test(url)) url = 'https://' + url
    const nav = this.#session.send('Page.navigate', { url }, waitMs).catch((error) => {
      // Aborted navigations are normal (redirects, downloads); only surface a
      // hard failure if the session itself is gone.
      if (this.#session.closed) throw error
      return null
    })
    await nav
    await this.waitForLoad(waitMs)
    const title = await this.evaluate('document.title').catch(() => '')
    const finalUrl = await this.evaluate('location.href').catch(() => url)
    return { url: finalUrl, title }
  }

  async locator(input, { byText = false } = {}) {
    await this.evaluate(LOCATE_HELPER)
    const found = await this.evaluate(
      `__dshResolve(${JSON.stringify(input)}, ${byText ? 'true' : 'false'})`,
    )
    return found
  }

  async click(input, { byText = false } = {}) {
    const hit = await this.locator(input, { byText })
    if (!hit) throw new Error(`no element matched ${byText ? 'text' : 'selector'} ${JSON.stringify(input)}`)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.#session.send('Input.dispatchMouseEvent', {
        type, x: hit.x, y: hit.y, button: 'left', clickCount: 1,
      })
    }
    await new Promise((r) => setTimeout(r, 150))
    return hit
  }

  /** Focus the element, then type. Real key events, so SPAs see them. */
  async type(input, text, { byText = false, clear = false, submit = false } = {}) {
    const hit = await this.locator(input, { byText })
    if (!hit) throw new Error(`no element matched ${byText ? 'text' : 'selector'} ${JSON.stringify(input)}`)
    await this.click(input, { byText })
    if (clear) {
      await this.evaluate(`(() => { const el = __dshResolve(${JSON.stringify(input)}, ${byText}); if (el && 'value' in el) el.value=''; document.execCommand && document.execCommand('selectAll', false, null); })()`)
      await this.#session.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      })
      await this.#session.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      })
    }
    for (const ch of String(text)) {
      await this.#session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch })
      await this.#session.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch })
    }
    if (submit) {
      await this.key('Enter')
      await new Promise((r) => setTimeout(r, 400))
    }
    return hit
  }

  async key(name) {
    const map = {
      Enter: { code: 'Enter', vk: 13 },
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 },
      Backspace: { code: 'Backspace', vk: 8 },
      ArrowDown: { code: 'ArrowDown', vk: 40 },
      ArrowUp: { code: 'ArrowUp', vk: 38 },
      PageDown: { code: 'PageDown', vk: 34 },
      PageUp: { code: 'PageUp', vk: 33 },
    }
    const k = map[name] ?? { code: name, vk: 0 }
    for (const type of ['keyDown', 'keyUp']) {
      await this.#session.send('Input.dispatchKeyEvent', {
        type, key: name, code: k.code,
        windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
      })
    }
    return { key: name }
  }

  async scroll({ deltaY = 600, deltaX = 0 } = {}) {
    await this.#session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.floor(this.#viewport.width / 2),
      y: Math.floor(this.#viewport.height / 2),
      deltaX, deltaY,
    })
    await new Promise((r) => setTimeout(r, 200))
    return { deltaX, deltaY }
  }

  /** Plain-text rendering of the page, capped so it stays affordable. */
  async text({ maxChars = 12_000, selector = null } = {}) {
    const expr = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : ''; })()`
      : "document.body ? (document.body.innerText || document.body.textContent || '') : ''"
    const raw = await this.evaluate(expr).catch(() => '')
    const text = String(raw ?? '').replace(/\n{3,}/g, '\n\n').trim()
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars, length: text.length }
  }

  /** Links on the page, resolved to absolute URLs. */
  async links({ limit = 100, selector = 'a[href]' } = {}) {
    return await this.evaluate(`(() => {
      const out = [];
      for (const a of document.querySelectorAll(${JSON.stringify(selector)})) {
        const href = a.href;
        if (!href || href.startsWith('javascript:')) continue;
        out.push({ text: (a.innerText || a.textContent || '').trim().slice(0, 160), href });
        if (out.length >= ${limit}) break;
      }
      return out;
    })()`) ?? []
  }

  /** Interactive elements, so a model can see what is clickable. */
  async elements({ limit = 120 } = {}) {
    return await this.evaluate(`(() => {
      const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[contenteditable=true],summary';
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120),
          name: el.getAttribute('name') || undefined,
          id: el.id || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
        });
        if (out.length >= ${limit}) break;
      }
      return out;
    })()`) ?? []
  }

  async screenshot({ fullPage = false, format = 'png', quality } = {}) {
    const params = { format }
    if (format === 'jpeg' && quality) params.quality = quality
    if (fullPage) {
      const metrics = await this.#session.send('Page.getLayoutMetrics')
      const size = metrics.cssContentSize ?? metrics.contentSize
      params.clip = {
        x: 0, y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1,
      }
      params.captureBeyondViewport = true
    }
    const shot = await this.#session.send('Page.captureScreenshot', params, 60_000)
    return { data: shot.data, format }
  }

  /** Share the current page state as one compact observation. */
  async observe({ maxChars = 12_000 } = {}) {
    const [title, url, text] = await Promise.all([
      this.evaluate('document.title').catch(() => ''),
      this.evaluate('location.href').catch(() => this.currentUrl()),
      this.text({ maxChars }),
    ])
    return { url, title, ...text }
  }
}

/** Convenience: navigate a fresh session and wrap it in PageActions. */
export async function openPage(port, options = {}) {
  const { openPageSession } = await import('./cdp.js')
  const { session, target } = await openPageSession(port, options)
  const actions = new PageActions(session, target, options.viewport)
  await actions.init({ viewport: options.viewport })
  return actions
}

export { CdpSession }
