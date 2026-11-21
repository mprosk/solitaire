# Tensies

Tensies solitaire: turn the deck one card at a time onto the end of a row, and clear the row in
groups of three that add up to 10, 20 or 30 (Ace 1, Jack/Queen/King 10). A group is three cards
in a row from either end, and the ends join up, so a group can wrap around. Installable as a
progressive web app and playable offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/tensies/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Tap three cards to clear them. Win by using up the deck with one card left (17 groups, a score
of 51). Once the row is too long to fit, the middle tucks away and only the three cards at each
end stay in view, since only they can play. Rules are under **How to play** in the game menu.
