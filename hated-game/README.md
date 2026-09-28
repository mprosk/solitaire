# The Hated Game

A lightweight, responsive browser version of the family solitaire game. Installable as a
progressive web app and playable offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

The server listens on every interface at port 8888 and prints a LAN URL for testing on
a phone. It sends `no-store` for HTML/CSS/JS so reloads are fresh. A real home-screen
install needs HTTPS: generate a self-signed cert into `certs/` (the script prints the
command) and run `python3 serve.py --https`.

Dev URL:

```text
http://127.0.0.1:8888/hated-game/?sw=off&stacked=1
```

- `?sw=off` unregisters the cache-first service worker on your browser and remembers
  the opt-out, so plain reloads always show fresh CSS/JS. (Without this, the worker
  serves stale assets no matter how hard you reload — restarting the server does not
  clear it.) `?sw=on` re-enables.
- `?stacked=1` deals a deterministic board with a legal 3-card stack on pile 3 and
  bypasses the session restore, so every reload lands on a board you can drag-test
  immediately — no re-dealing for a lucky hand. Stacked deals never post results to
  the leaderboard.

Drag a card (or vertical stack) to its destination using a mouse, touch, or pen. The game
only completes legal moves.
