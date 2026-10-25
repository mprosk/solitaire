# Pyramid

Pyramid solitaire: clear a pyramid of 28 cards, every other row dealt face down, in pairs that add
up to 13. Installable as a
progressive web app and playable offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/pyramid/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Tap two cards that add up to 13 (or a lone King), or drag one onto the other. The deck turns
three at a time, as many times through as you like. Rules are under **How to play** in the
game menu.
