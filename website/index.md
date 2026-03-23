---
hide:
  - navigation
---

# relay-tty

**Run terminal commands on your computer, access them from any browser.**

Phone, tablet, laptop — whatever you have nearby. Sessions survive disconnects, multiple people can watch at once, and you don't need SSH or tmux.

---

## Why relay-tty?

- **Access your terminal from anywhere** — start a command on your Mac, check on it from your phone
- **No SSH, no tmux, no port forwarding** — just `relay bash` and open a browser
- **Sessions persist** — disconnect and reconnect without losing output
- **Share instantly** — generate a read-only link or QR code for anyone to watch
- **Mobile-first web UI** — PWA with touch scrolling, scratchpad input, voice dictation
- **Multiple views** — full terminal, grid gallery, or side-by-side lanes

---

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/ddrscott/relay-tty/main/install.sh | bash
```

Or with Node.js:

```bash
npm i -g relay-tty
```

---

## 30-Second Demo

```bash
# Start a session and attach locally
relay bash

# Detach with Ctrl+] — session keeps running

# Start the web server
relay server start

# Open http://localhost:7680 in any browser
```

Want to access it from your phone? Add `--tunnel`:

```bash
relay server start --tunnel
# Prints a public URL + QR code
```

---

## Next Steps

<div class="grid cards" markdown>

- :material-school: **[Getting Started](tutorials/getting-started.md)**

    Install relay-tty and open your first session in a browser

- :material-cellphone: **[Mobile Access](tutorials/mobile-access.md)**

    Access your terminal from your phone with a QR code

- :material-share-variant: **[Share a Terminal](tutorials/sharing-terminal.md)**

    Let someone watch your terminal in real-time

- :material-view-grid: **[Web UI Views](how-to/web-ui-views.md)**

    Grid gallery, lanes view, and layout switching

</div>
