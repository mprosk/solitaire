# Leapfrog

Leapfrog solitaire: deal the deck one card at a time onto the end of a row. A stack can go on the
stack right before it, or leapfrog onto the one two back, when their top cards share a suit or a
rank. Any stack in the row can move, so one move can set off a cascade. Win by using up the deck
with every card in one stack (a score of 51). Installable as a progressive web app and playable
offline after the first visit.

## Play

Serve the repo root (the game imports `../lib/` for accounts and the leaderboard):

```bash
python3 serve.py          # from the repo root
```

Dev URL:

```text
http://127.0.0.1:8888/leapfrog/?sw=off
```

`?sw=off` unregisters the service worker on your browser and remembers the opt-out;
`?sw=on` re-enables.

Tap a stack to move it (when it could go either place, tap it and then tap where it goes), or drag
it onto the stack it should go on. Rules are under **How to play** in the game menu.
