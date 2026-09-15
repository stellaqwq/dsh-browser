# dsh-browser

Real-browser automation for [DeepSeek Harness](https://github.com/anywhere-labs) (DSH).

Drives a real Chrome over the DevTools Protocol, so the model can read pages that
need JavaScript, click through interfaces, fill in forms, and keep a logged-in
session between calls.

## Why this exists

DSH already ships `web_search` and `web_fetch`, but those read static HTML. A large
share of what people actually ask for lives behind JavaScript, an interaction, or a
login — dashboards, docs behind a search box, anything rendered client-side, anything
that needs a session. This plugin gives the model a real browser instead.

## Install

From the DSH Desktop plugin settings, install:

```
dsh-browser
```

Or from a checkout:

```bash
pnpm add dsh-browser
```

Then add it to your profile's bundle list (DSH does this for you when installed from
the UI):

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-browser"]
    }
  }
}
```

Restart DSH. The model gains a `browser` tool.

## Requirements

- **Chrome or Edge installed.** The plugin finds it automatically. Override with
  `browserPath` in the plugin config if yours lives somewhere unusual.
- **Node 22.19+.** No third-party dependencies — the CDP client is built on the
  built-in `WebSocket` and `fetch`.

## The `browser` tool

One tool with an `action` switch, because browser work is a sequence of steps
against shared state rather than a set of independent operations.

| Action | What it does |
| --- | --- |
| `launch` | Start or attach to the browser and report its tabs |
| `goto` | Navigate, then return the page as text |
| `observe` | Re-read the current page as text |
| `text` | Page text, optionally scoped to a selector |
| `elements` | List interactive elements (buttons, links, fields) |
| `links` | List links with absolute hrefs |
| `screenshot` | Capture the viewport or the full page as an image |
| `click` | Click a selector, or an element found by its visible text |
| `type` | Type into a field; optionally clear first or submit with Enter |
| `key` | Press Enter, Tab, Escape, Arrow keys, PageUp/PageDown, Backspace |
| `scroll` | Scroll the page |
| `evaluate` | Run JavaScript and return its value |
| `tabs` / `switch_tab` / `new_tab` / `close_tab` | Tab management |
| `back` | History back |
| `wait` | Pause, then re-read the page |
| `close_browser` | Close a browser this plugin launched |

Most reading actions return `{ url, title, text }`.

## A typical session

```
browser { action: "goto", url: "https://example.com/docs" }
browser { action: "type", selector: "input[type=search]", value: "installation", submit: true }
browser { action: "observe" }
browser { action: "click", text: "Getting started", byText: true }
browser { action: "screenshot", fullPage: true }
```

## Logins persist

The browser runs against a dedicated profile directory
(`~/.dsh/browser-profile` by default), not your everyday Chrome profile. That is
deliberate: Chrome refuses to enable a DevTools port on a profile another instance
already holds, so sharing your main profile would break the tool whenever your own
browser is open.

The practical effect is that **you sign in once**. That profile keeps its cookies, so
later calls — and later sessions — arrive already authenticated.

If a site needs a human sign-in, ask the model to open the page and sign in yourself
in the window that appears, then tell it to continue.

## Configuration

Passed as the plugin's `config` in `cordis.patch.yml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `9222` | DevTools port |
| `browserPath` | auto-detected | Explicit Chrome/Edge executable |
| `profileDir` | `~/.dsh/browser-profile` | Persistent profile directory |
| `headless` | `false` | Run without a visible window |
| `maxChars` | `12000` | Default cap on returned page text |
| `extraArgs` | `[]` | Extra Chrome flags |

Example:

```yaml
- insert:
    - id: dsh-browser
      name: 'dsh-browser'
      config:
        headless: false
        port: 9222
```

## Security notes

This tool can operate a browser on the user's behalf: it can click buttons, submit
forms, and act inside authenticated sessions. Treat it with the same care as shell
access.

- It cannot read your everyday browser profile's cookies; it uses a separate one.
- Actions with real-world consequences (payments, deletions, sending messages) are
  good candidates for DSH's approval prompts.
- `close_browser` only closes a browser this plugin launched. A Chrome you started
  yourself is left running.

## How it works

```
dsh/index.js     tool definition + action dispatch
dsh/browser.js   Chrome discovery, launch, persistent profile
dsh/actions.js   navigation, observation, interaction
dsh/cdp.js       minimal CDP client over the built-in WebSocket
```

No Playwright, no Puppeteer, no dependencies — the DevTools Protocol is JSON-RPC
over a WebSocket, and Node has shipped both for years.

## License

MIT
