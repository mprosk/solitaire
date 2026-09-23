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

Drag a card (or vertical stack) to its destination using a mouse, touch, or pen. The game
only completes legal moves.
