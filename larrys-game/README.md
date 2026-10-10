# Larry’s Game

A lightweight, responsive browser version of the family solitaire game. Installable as a
progressive web app and playable offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/larrys-game/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Tap a card to play it to its suit column (a pile card with no column move goes to an
empty pile), or drag it. Rules are under **How to play** in the game menu.
