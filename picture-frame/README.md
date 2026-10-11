# Picture Frame

Picture Frame solitaire: frame the board with face cards and clear the rest in pairs of 10. Installable as a
progressive web app and playable offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/picture-frame/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Tap an empty spot to place the revealed card; once the board is full, tap two cards that
add up to 10 to clear them. Rules are under **How to play** in the game menu.
