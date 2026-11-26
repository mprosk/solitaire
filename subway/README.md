# Subway

Subway solitaire, a game you can play holding the cards on a train: pick the deck up one card at
a time into your hand, and discard from anywhere in the hand when cards make a play. A pair of
the same rank side by side goes; two of the same suit with two cards between them discard the
two between; two of the same rank with two between discard all four. Each discard closes up the
hand and can set up new plays. Win by using up the deck with an empty hand (all 52 discarded).
Installable as a progressive web app and playable offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/subway/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Tap the cards a play discards to discard them. When a pair sits inside a play of four, tap the
other two to discard all four, or tap a picked card again to discard just the pair. Rules are
under **How to play** in the game menu.
