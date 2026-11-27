# Aunt Ella 1

Aunt Ella 1 solitaire: the whole deck is dealt at the start. Deal regular solitaire (seven
columns, one card face up on top of 0 to 6 face-down cards), then deal the rest of the deck face
up onto columns 2 to 7, four cards each. Build the foundations up by suit from the Aces; in the
columns, build down by suit, onto the bottom card of a column only, moving any face-up card with
everything below it, even from the middle of a column. Only Kings fill empty columns. Twice a
game, when no moves are left, a King can start a new column (up to nine). Win with every card on
the foundations (a score of 52). Installable as a progressive web app and playable offline after
the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/aunt-ella-1/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Tap a card to move it (up to its foundation if it can go, else onto the next higher card of its
suit, else a King into an empty column, or onto a new column when that cheat is open), or drag it
where it should go. Rules are under **How to play** in the game menu.
