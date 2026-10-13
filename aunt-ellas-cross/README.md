# Aunt Ella’s Cross

Aunt Ella’s Cross solitaire: build four suits up from a cross of five stacks. Installable as a
progressive web app and playable offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/aunt-ellas-cross/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Drag a card to its destination, or double-click it to send it to its up pile. Rules are under
**How to play** in the game menu.
