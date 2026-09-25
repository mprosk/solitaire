# The Hated Game

A lightweight, responsive browser version of the family solitaire game. Installable as a
progressive web app and playable offline after the first visit.

## Play

Serve the folder over HTTP (required for install / offline), then open it in a browser:

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`. On a supported browser, use “Install” / “Add to Home
Screen” to install it.

You can still open `index.html` directly, but service workers and install prompts need a
local server or HTTPS.

## Local development

Serve with the bundled script (sends `no-store` for game assets so reloads are fresh):

```bash
python3 hated-game/serve.py 8080
```

Then use this dev URL:

```text
http://127.0.0.1:8080/?sw=off&stacked=1
```

- `?sw=off` unregisters the cache-first service worker on your browser and remembers
  the opt-out, so plain reloads always show fresh CSS/JS. (Without this, the worker
  serves stale assets no matter how hard you reload — restarting the server does not
  clear it.) `?sw=on` re-enables.
- `?stacked=1` deals a deterministic board with a legal 3-card stack on pile 3 and
  bypasses the session restore, so every reload lands on a board you can drag-test
  immediately — no re-dealing for a lucky hand.

Drag a card (or vertical stack) to its destination using a mouse, touch, or pen. The game
only completes legal moves.
