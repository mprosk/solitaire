# Aces

Aces solitaire: deal the deck four cards at a time, one onto each of four piles, and discard
the lower card whenever two bottom cards share a suit (Aces high). Win by using up the deck
with only the four Aces left (48 cards discarded). Installable as a progressive web app and
playable offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/aces/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Tap a bottom card to discard it when a higher card of its suit is showing. With a pile empty,
drag any bottom card into the space, or tap one that can't be discarded to move it there (to
move one that could be discarded by tapping, tap the empty pile first). Empty piles must be
filled before the next deal whenever another pile has a card to spare. Rules are under **How to play** in the game menu.
