/**
 * HTML + plain-text renderers for the player emails. Pure functions (no Deno or
 * network APIs) so scripts/email-preview.ts can render them locally.
 *
 * Email HTML rules followed here: table layout, inline styles only, no web fonts,
 * no images (nothing to block), 600px max width, and a plain-text part.
 */

export type GameRow = {
  slug: string;
  name: string;
  games: number;
  wins: number;
  best_score: number;
  full_score: number;
  rank: number | null;
  rank_before: number | null;
  players: number | null;
};

export type Rival = { name: string; wins: number; games: number };

export type Leaderboard = {
  slug: string;
  name: string;
  rank: number;
  /** Rank at the start of the period (week, or day for alerts); null if unranked then. */
  rank_before?: number | null;
  players: number;
  wins: number;
  games: number;
  leader: Rival | null;
  above: Rival | null;
  below: Rival | null;
};

export type WeeklyPayload = {
  screen_name: string | null;
  week_start: string;
  week_end: string;
  unsubscribe_token: string;
  totals: { games: number; wins: number; days: number };
  previous_week: { games: number; wins: number };
  days_played: boolean[];
  games: GameRow[];
  all_time: { games: number; wins: number };
  leaderboards: Leaderboard[];
  table: {
    games: number;
    players: number;
    leaders: { name: string; games: number; wins: number }[];
  };
};

export type Standing = {
  slug: string;
  name: string;
  rank_then: number;
  rank_now: number;
  players: number;
  passed_by: string[];
};

export type MissedYouPayload = {
  screen_name: string | null;
  last_played: string;
  days_away: number;
  unsubscribe_token: string;
  all_time: { games: number; wins: number };
  favorite_game: { slug: string; name: string; games: number };
  since: { games: number; players: number };
  standings: Standing[];
  new_games: { slug: string; name: string }[];
};

export type LostLeadPayload = {
  screen_name: string | null;
  /** The New York calendar day the #1 spot was lost. */
  day: string;
  unsubscribe_token: string;
  games: Leaderboard[];
};

export type EmailKind = "weekly_summary" | "missed_you" | "lost_lead";

export type RenderedEmail = { subject: string; html: string; text: string };

/** Base URL of the site, e.g. "https://guygames.net" (no trailing slash). */
export type Links = { site: string };

const C = {
  felt: "#18563d",
  feltDark: "#103d2c",
  cream: "#f7f1e5",
  paper: "#fffdf8",
  ink: "#19201d",
  muted: "#5f6b65",
  line: "#e6dfd0",
  red: "#b92f3d",
  gold: "#e8c46b",
  up: "#1d7a4c",
};

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const KIND_LABEL: Record<EmailKind, string> = {
  weekly_summary: "weekly summaries",
  missed_you: "“we’ve missed you” emails",
  lost_lead: "leaderboard alerts",
};

export function unsubscribeUrl(links: Links, kind: EmailKind, token: string): string {
  return `${links.site}/account/?unsubscribe=${encodeURIComponent(token)}&email=${kind}`;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const n = (value: number) => value.toLocaleString("en-US");
const plural = (count: number, one: string, many = `${one}s`) =>
  `${n(count)} ${count === 1 ? one : many}`;
const pct = (wins: number, games: number) => (games ? `${Math.round((wins / games) * 100)}%` : "—");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m: m - 1, d };
}

/** "Nov 9 – 15" or "Oct 26 – Nov 1". */
export function dateRange(startIso: string, endIso: string): string {
  const a = parseDay(startIso);
  const b = parseDay(endIso);
  const left = `${MONTHS[a.m]} ${a.d}`;
  const right = a.m === b.m ? `${b.d}` : `${MONTHS[b.m]} ${b.d}`;
  return `${left} – ${right}`;
}

function longDate(iso: string): string {
  const { m, d } = parseDay(iso);
  return `${MONTHS[m]} ${d}`;
}

function rankText(rank: number | null, players: number | null): string {
  return rank ? `#${rank} of ${players}` : "Unranked";
}

/** "▲ 2", "▼ 1", or "" for movement between two ranks (lower is better). */
function rankMove(before: number | null, now: number | null): { html: string; text: string } {
  if (!now) return { html: "", text: "" };
  if (!before) return { html: ` <span style="color:${C.up};">new</span>`, text: " (new)" };
  const delta = before - now;
  if (delta > 0) {
    return { html: ` <span style="color:${C.up};">▲&nbsp;${delta}</span>`, text: ` (up ${delta})` };
  }
  if (delta < 0) {
    return {
      html: ` <span style="color:${C.red};">▼&nbsp;${-delta}</span>`,
      text: ` (down ${-delta})`,
    };
  }
  return { html: "", text: "" };
}

function deltaLine(now: number, before: number): string {
  const diff = now - before;
  if (before === 0 && now === 0) return "&nbsp;";
  if (diff === 0) return `same as last week`;
  const arrow = diff > 0
    ? `<span style="color:${C.up};">▲</span>`
    : `<span style="color:${C.red};">▼</span>`;
  return `${arrow} ${n(Math.abs(diff))} vs last week`;
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

function layout(opts: {
  preheader: string;
  eyebrow: string;
  body: string;
  footer: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>GuyGames Solitaire</title>
</head>
<body style="margin:0;padding:0;background:${C.felt};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${
    esc(opts.preheader)
  }&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.felt};">
<tr><td align="center" style="padding:28px 12px 36px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
    <tr><td align="center" style="padding:0 0 18px;font-family:${SERIF};font-size:19px;font-weight:bold;letter-spacing:0.01em;color:#ffffff;">
      <span style="color:#000000;">♠&#xFE0E;</span> <span style="color:#ff5a6e;">♥&#xFE0E;</span> GuyGames Solitaire <span style="color:#ff5a6e;">♦&#xFE0E;</span> <span style="color:#000000;">♣&#xFE0E;</span>
    </td></tr>
    <tr><td style="background:${C.paper};border-radius:16px;padding:28px 26px 26px;font-family:${SANS};color:${C.ink};">
      <div style="font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:${C.felt};">${
    esc(opts.eyebrow)
  }</div>
      ${opts.body}
    </td></tr>
    <tr><td align="center" style="padding:20px 16px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:rgba(255,255,255,0.72);">
      ${opts.footer}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function h1(text: string): string {
  return `<h1 style="margin:6px 0 10px;font-family:${SERIF};font-size:28px;line-height:1.2;font-weight:bold;color:${C.ink};">${
    esc(text)
  }</h1>`;
}

function h2(text: string): string {
  return `<h2 style="margin:28px 0 10px;font-family:${SERIF};font-size:19px;font-weight:bold;color:${C.ink};">${
    esc(text)
  }</h2>`;
}

function para(html: string, extra = ""): string {
  return `<p style="margin:0 0 12px;font-size:16px;line-height:1.5;color:${C.ink};${extra}">${html}</p>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto 4px;">
<tr><td align="center" bgcolor="${C.felt}" style="border-radius:10px;">
  <a href="${
    esc(href)
  }" style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:17px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;">${
    esc(label)
  }</a>
</td></tr>
</table>`;
}

function statTiles(tiles: { label: string; value: string; note: string }[]): string {
  const cells = tiles
    .map(
      (t) =>
        `<td width="${Math.floor(100 / tiles.length)}%" valign="top" style="padding:0 4px;">
  <div style="background:${C.cream};border-radius:12px;padding:14px 10px 12px;text-align:center;">
    <div style="font-size:12px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};">${
          esc(t.label)
        }</div>
    <div style="margin-top:4px;font-family:${SERIF};font-size:30px;font-weight:bold;color:${C.ink};">${
          esc(t.value)
        }</div>
    <div style="margin-top:4px;font-size:12px;line-height:1.35;color:${C.muted};">${t.note}</div>
  </div>
</td>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 6px;table-layout:fixed;"><tr>${cells}</tr></table>`;
}

function dayStrip(days: boolean[]): string {
  const letters = ["M", "T", "W", "T", "F", "S", "S"];
  const names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const cells = letters
    .map((letter, i) => {
      const on = Boolean(days[i]);
      return `<td align="center" style="padding:0 3px;">
  <div title="${names[i]}${
        on ? " — played" : ""
      }" style="width:34px;height:34px;line-height:34px;border-radius:8px;font-size:13px;font-weight:bold;text-align:center;${
        on ? `background:${C.felt};color:#ffffff;` : `background:#efeadf;color:#a49c8c;`
      }">${letter}</div>
</td>`;
    })
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px auto 0;"><tr>${cells}</tr></table>`;
}

function dataTable(headers: { label: string; align?: string }[], rows: string[][]): string {
  const th = headers
    .map(
      (h) =>
        `<th align="${
          h.align ?? "left"
        }" style="padding:8px 6px;border-bottom:2px solid ${C.line};font-size:11px;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;white-space:nowrap;color:${C.muted};">${
          esc(h.label)
        }</th>`,
    )
    .join("");
  const body = rows
    .map(
      (cells) =>
        `<tr>${
          cells
            .map(
              (cell, i) =>
                `<td align="${
                  headers[i].align ?? "left"
                }" style="padding:10px 6px;border-bottom:1px solid ${C.line};font-size:15px;color:${C.ink};${
                  i > 0 ? "white-space:nowrap;" : ""
                }">${cell}</td>`,
            )
            .join("")
        }</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>${th}</tr>${body}</table>`;
}

function footer(links: Links, kind: EmailKind, token: string, why: string): string {
  return `${esc(why)}<br>
<a href="${esc(unsubscribeUrl(links, kind, token))}" style="color:#ffffff;">Unsubscribe from ${
    KIND_LABEL[kind]
  }</a>
&nbsp;·&nbsp;
<a href="${esc(`${links.site}/account/`)}" style="color:#ffffff;">Email settings</a>`;
}

function textFooter(links: Links, kind: EmailKind, token: string, why: string): string {
  return `--
${why}
Unsubscribe from ${KIND_LABEL[kind].replace(/[“”]/g, '"')}: ${unsubscribeUrl(links, kind, token)}
Email settings: ${links.site}/account/`;
}

// ---------------------------------------------------------------------------
// Weekly summary
// ---------------------------------------------------------------------------

export function renderWeeklySummary(p: WeeklyPayload, links: Links): RenderedEmail {
  const name = p.screen_name || "there";
  const range = dateRange(p.week_start, p.week_end);
  const { games, wins, days } = p.totals;
  const prev = p.previous_week;

  const subject = `Your week: ${plural(games, "game")}, ${plural(wins, "win")}`;
  const winsClause = wins > 0 ? ` and won ${n(wins)}` : "";
  const when = days >= 7 ? "every day this week" : `on ${plural(days, "day")} this week`;
  const summary = `You played ${plural(games, "game")} ${when}${winsClause}.`;

  const tiles = statTiles([
    { label: "Games", value: n(games), note: deltaLine(games, prev.games) },
    { label: "Wins", value: n(wins), note: deltaLine(wins, prev.wins) },
    {
      label: "Win rate",
      value: pct(wins, games),
      note: prev.games ? `last week ${pct(prev.wins, prev.games)}` : "&nbsp;",
    },
  ]);

  const gameRows = p.games.map((g) => {
    const move = rankMove(g.rank_before, g.rank);
    const best = g.wins === 0
      ? `<div style="margin-top:2px;font-size:12px;font-weight:normal;color:${C.muted};">Best: ${g.best_score} of ${g.full_score} cards</div>`
      : "";
    return [
      `<a href="${
        esc(`${links.site}/${g.slug}/`)
      }" style="color:${C.ink};font-weight:bold;text-decoration:none;">${esc(g.name)}</a>${best}`,
      n(g.games),
      n(g.wins),
      pct(g.wins, g.games),
      `${g.rank ? `#${g.rank}` : "—"}${move.html}`,
    ];
  });

  const boards = leaderboardSummary(p.leaderboards, p.screen_name || "You");

  const leaders = p.table.leaders
    .map((l, i) => {
      const you = p.screen_name && l.name === p.screen_name;
      return `<tr>
  <td width="28" style="padding:7px 0;font-family:${SERIF};font-size:16px;font-weight:bold;color:${C.muted};">${
        i + 1
      }.</td>
  <td style="padding:7px 0;font-size:15px;color:${C.ink};${you ? "font-weight:bold;" : ""}">${
        esc(l.name)
      }${you ? ` <span style="font-size:12px;color:${C.felt};">(you)</span>` : ""}</td>
  <td align="right" style="padding:7px 0;font-size:14px;color:${C.muted};">${
        plural(l.games, "game")
      } · ${plural(l.wins, "win")} · ${pct(l.wins, l.games)}</td>
</tr>`;
    })
    .join("");

  const body = `
${h1(`Hi ${name}`)}
${para(esc(summary))}
${tiles}
<div style="margin:18px 0 0;text-align:center;font-size:13px;color:${C.muted};">Days you played</div>
${dayStrip(p.days_played)}
${h2("Your games this week")}
${
    dataTable(
      [
        { label: "Game" },
        { label: "Played", align: "right" },
        { label: "Won", align: "right" },
        { label: "Win %", align: "right" },
        { label: "Rank", align: "right" },
      ],
      gameRows,
    )
  }
<p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:${C.muted};">Rank is your all-time spot on each game’s leaderboard (by total wins) as of Sunday night; arrows show the change this week.</p>
${boards.html}
${h2("Around the table")}
${
    para(
      `${plural(p.table.players, "player")} dealt ${
        plural(p.table.games, "game")
      } this week. Most games played:`,
    )
  }
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${leaders}</table>
${
    para(
      `All time you’ve played ${plural(p.all_time.games, "game")} and won ${n(p.all_time.wins)} (${
        pct(p.all_time.wins, p.all_time.games)
      }).`,
      "margin-top:18px;color:#3d4743;font-size:14px;",
    )
  }
${button(`${links.site}/`, "Deal me in")}`;

  const html = layout({
    preheader: `${summary} Here’s how you stacked up.`,
    eyebrow: `Your week · ${range}`,
    body,
    footer: footer(
      links,
      "weekly_summary",
      p.unsubscribe_token,
      "You’re getting this because you played GuyGames Solitaire this week.",
    ),
  });

  const textGames = p.games
    .map((g) => {
      const best = g.wins === 0 ? `, best ${g.best_score} of ${g.full_score} cards` : "";
      return `- ${g.name}: ${plural(g.games, "game")}, ${plural(g.wins, "win")} (${
        pct(g.wins, g.games)
      })${best}, ${rankText(g.rank, g.players)}${rankMove(g.rank_before, g.rank).text}`;
    })
    .join("\n");
  const textLeaders = p.table.leaders
    .map((l, i) =>
      `${i + 1}. ${l.name}: ${plural(l.games, "game")}, ${plural(l.wins, "win")} (${
        pct(l.wins, l.games)
      })`
    )
    .join("\n");
  const text = `Your week at GuyGames Solitaire (${range})

Hi ${name},

${summary}
Games: ${n(games)} (last week ${n(prev.games)})
Wins: ${n(wins)} (last week ${n(prev.wins)})
Win rate: ${pct(wins, games)} (last week ${pct(prev.wins, prev.games)})

Your games this week:
${textGames}
${boards.text}

Around the table: ${plural(p.table.players, "player")} dealt ${
    plural(p.table.games, "game")
  } this week.
${textLeaders}

Play: ${links.site}/

${
    textFooter(
      links,
      "weekly_summary",
      p.unsubscribe_token,
      "You're getting this because you played GuyGames Solitaire this week.",
    )
  }`;

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// We've missed you
// ---------------------------------------------------------------------------

export function renderMissedYou(p: MissedYouPayload, links: Links): RenderedEmail {
  const name = p.screen_name || "friend";
  const fav = p.favorite_game;
  // Lead with the game they care about most if someone passed them there.
  const passed = p.standings.find((s) => s.slug === fav.slug && s.passed_by.length) ??
    p.standings.find((s) => s.passed_by.length);

  const subject = passed
    ? `${passed.passed_by[0]} passed you in ${passed.name}`
    : "We’ve missed you at GuyGames";
  const awayLine = `It’s been ${plural(p.days_away, "day")} since your last game on ${
    longDate(p.last_played)
  }.`;
  const busyLine = p.since.games > 0
    ? `The table kept busy while you were away: ${plural(p.since.players, "player")} dealt ${
      plural(p.since.games, "game")
    }.`
    : "";

  const standingRows = p.standings.map((s) => {
    const moved = s.rank_now !== s.rank_then;
    const who = s.passed_by.length
      ? `<div style="margin-top:2px;font-size:12px;color:${C.red};">Passed by ${
        esc(listNames(s.passed_by))
      }</div>`
      : "";
    return [
      `<span style="font-weight:bold;">${esc(s.name)}</span>${who}`,
      `#${s.rank_then}`,
      `<span style="${
        moved ? `color:${C.red};font-weight:bold;` : ""
      }">#${s.rank_now}</span> <span style="color:${C.muted};font-size:12px;">of ${s.players}</span>`,
    ];
  });

  const newGames = p.new_games.length
    ? `${h2(p.new_games.length === 1 ? "New since you left" : "New games since you left")}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${
      p.new_games
        .map(
          (g) =>
            `<tr><td style="padding:4px 0;">
  <a href="${
              esc(`${links.site}/${g.slug}/`)
            }" style="display:block;background:${C.cream};border-radius:12px;padding:14px 16px;font-family:${SERIF};font-size:18px;font-weight:bold;color:${C.ink};text-decoration:none;">${
              esc(g.name)
            } <span style="float:right;font-family:${SANS};font-size:13px;color:${C.felt};">Try it →</span></a>
</td></tr>`,
        )
        .join("")
    }</table>`
    : "";

  const body = `
${h1(`We’ve missed you, ${name}`)}
${para(esc(awayLine))}
${busyLine ? para(esc(busyLine)) : ""}
${newGames}
${
    p.standings.length
      ? `${h2("Where you stand")}
${
        dataTable(
          [{ label: "Game" }, { label: "Then", align: "right" }, { label: "Now", align: "right" }],
          standingRows,
        )
      }
<p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:${C.muted};">Rank is by total wins on the leaderboard.</p>`
      : ""
  }
${
    para(
      `Your record so far: ${plural(p.all_time.games, "game")}, ${
        plural(p.all_time.wins, "win")
      } (${pct(p.all_time.wins, p.all_time.games)}).`,
      "margin-top:20px;color:#3d4743;font-size:14px;",
    )
  }
${button(`${links.site}/${fav.slug}/`, `Play ${fav.name}`)}
<p style="margin:10px 0 0;text-align:center;font-size:13px;"><a href="${
    esc(`${links.site}/`)
  }" style="color:${C.felt};">or pick any game</a></p>`;

  const html = layout({
    preheader: passed
      ? `${awayLine} You’re now #${passed.rank_now} in ${passed.name}.`
      : `${awayLine} Here’s what you missed.`,
    eyebrow: "The table misses you",
    body,
    footer: footer(
      links,
      "missed_you",
      p.unsubscribe_token,
      "You’re getting this because you haven’t played GuyGames Solitaire in a while. We send it once per break.",
    ),
  });

  const text = `We've missed you, ${name}

${awayLine}
${busyLine}
${
    p.new_games.length
      ? `\nNew since you left: ${
        p.new_games.map((g) => `${g.name} (${links.site}/${g.slug}/)`).join(", ")
      }\n`
      : ""
  }
${
    p.standings.length
      ? `Where you stand:\n${
        p.standings
          .map(
            (s) =>
              `- ${s.name}: #${s.rank_then} -> #${s.rank_now} of ${s.players}${
                s.passed_by.length ? ` (passed by ${listNames(s.passed_by)})` : ""
              }`,
          )
          .join("\n")
      }\n`
      : ""
  }
Your record so far: ${plural(p.all_time.games, "game")}, ${plural(p.all_time.wins, "win")} (${
    pct(p.all_time.wins, p.all_time.games)
  }).

Play ${fav.name}: ${links.site}/${fav.slug}/

${
    textFooter(
      links,
      "missed_you",
      p.unsubscribe_token,
      "You're getting this because you haven't played GuyGames Solitaire in a while. We send it once per break.",
    )
  }`;

  return { subject, html, text: text.replace(/\n{3,}/g, "\n\n") };
}

// ---------------------------------------------------------------------------
// Leaderboard summary (weekly email)
// ---------------------------------------------------------------------------

/**
 * Close race: within 3 wins (or 5% of the higher total, for big totals). Boards where
 * nobody has 5 wins yet don't count; 0–1 isn't a race.
 */
function isClose(a: number, b: number): boolean {
  const high = Math.max(a, b);
  return high >= 5 && Math.abs(a - b) <= Math.max(3, Math.ceil(high * 0.05));
}

type BoardRow = { rank: number; name: string; wins: number; games: number; you: boolean };

/** The slice of a board worth showing: the leader, the player above, you, the player below. */
function boardRows(b: Leaderboard, you: string): (BoardRow | null)[] {
  const rows: (BoardRow | null)[] = [];
  const add = (rank: number, r: Rival) => rows.push({ rank, ...r, you: false });
  if (b.leader && b.rank - 1 > 1) {
    add(1, b.leader);
    if (b.rank - 1 > 2) rows.push(null); // gap marker
  }
  if (b.above) add(b.rank - 1, b.above);
  rows.push({ rank: b.rank, name: you, wins: b.wins, games: b.games, you: true });
  if (b.below) add(b.rank + 1, b.below);
  return rows;
}

function classify(b: Leaderboard) {
  const closeAbove = Boolean(b.above && isClose(b.above.wins, b.wins));
  const closeBelow = Boolean(b.below && isClose(b.wins, b.below.wins));
  return { lead: b.rank === 1, close: closeAbove || closeBelow };
}

/** One board's slice as a small table, with a #rank badge (gold at #1) and close-race tag. */
function boardTable(
  b: Leaderboard,
  you: string,
  d: { lead: boolean; close: boolean; lostLead?: boolean },
): string {
  const cell = (content: string, align: "left" | "right", extra = "") =>
    `<td align="${align}" style="padding:6px 6px;font-size:14px;white-space:nowrap;${extra}">${content}</td>`;

  const badge =
    `<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:13px;font-weight:bold;white-space:nowrap;color:${C.ink};background:${
      d.lead ? C.gold : "#efeadf"
    };">#${b.rank} of ${b.players}</span>`;
  const pill = (label: string) =>
    ` <span style="display:inline-block;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:bold;letter-spacing:0.04em;text-transform:uppercase;white-space:nowrap;background:#fbe3e5;color:${C.red};">${label}</span>`;
  const tag = d.lostLead ? pill("Lost #1") : d.close ? pill("Close race") : "";
  const rows = boardRows(b, you)
    .map((r) => {
      if (!r) {
        return `<tr><td colspan="5" style="padding:0 6px;font-size:13px;line-height:14px;color:${C.muted};">⋮</td></tr>`;
      }
      const gap = r.you ? "" : r.wins - b.wins;
      const gapHtml = gap === ""
        ? `<span style="color:${C.muted};">—</span>`
        : gap === 0
        ? "tied"
        : `${gap > 0 ? "+" : "−"}${n(Math.abs(gap))}`;
      const shade = r.you ? `background:#e8f1ec;font-weight:bold;` : "";
      return `<tr>
  ${cell(`#${r.rank}`, "left", `color:${C.muted};${shade}`)}
  ${
        cell(
          `${esc(r.name)}${
            r.you ? ` <span style="font-size:12px;color:${C.felt};">(you)</span>` : ""
          }`,
          "left",
          `width:100%;white-space:normal;${shade}`,
        )
      }
  ${cell(n(r.wins), "right", shade)}
  ${cell(pct(r.wins, r.games), "right", shade)}
  ${cell(gapHtml, "right", `color:${C.muted};${shade}`)}
</tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">
  <tr>
    <td style="padding:0 0 6px;font-size:16px;font-weight:bold;color:${C.ink};">${
    esc(b.name)
  }${tag}</td>
    <td align="right" valign="top" style="padding:0 0 6px 8px;">${badge}</td>
  </tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;color:${C.ink};">
  <tr>
    <th align="left" style="padding:4px 6px;border-bottom:1px solid ${C.line};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};">#</th>
    <th align="left" style="padding:4px 6px;border-bottom:1px solid ${C.line};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};">Player</th>
    <th align="right" style="padding:4px 6px;border-bottom:1px solid ${C.line};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};">Wins</th>
    <th align="right" style="padding:4px 6px;border-bottom:1px solid ${C.line};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;white-space:nowrap;color:${C.muted};">Win %</th>
    <th align="right" style="padding:4px 6px;border-bottom:1px solid ${C.line};font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.muted};">Gap</th>
  </tr>
  ${rows}
</table>`;
}

function leaderboardSummary(boards: Leaderboard[], you: string): { html: string; text: string } {
  if (!boards.length) return { html: "", text: "" };

  const items = boards
    .map((board) => ({
      board,
      ...classify(board),
      lostLead: board.rank_before === 1 && board.rank > 1,
    }))
    .sort(
      (a, b) =>
        Number(b.lostLead) - Number(a.lostLead) ||
        Number(b.lead) - Number(a.lead) ||
        Number(b.close) - Number(a.close) ||
        a.board.rank - b.board.rank ||
        b.board.games - a.board.games,
    );

  const leads = items
    .filter((d) => d.lead)
    .map((d) => (d.close ? `${d.board.name} (narrowly)` : d.board.name));
  const races = items.filter((d) => d.close && !d.lead && !d.lostLead).map((d) => d.board.name);
  const lost = items
    .filter((d) => d.lostLead)
    .map((d) => {
      const taker = d.board.leader ?? (d.board.rank === 2 ? d.board.above : null);
      return taker ? `${d.board.name} to ${taker.name}` : d.board.name;
    });
  const intro = [
    lost.length ? `You lost #1 in ${listNames(lost)} this week.` : "",
    leads.length ? `You’re #1 in ${listNames(leads)}.` : "",
    races.length ? `Close race${races.length > 1 ? "s" : ""} in ${listNames(races)}.` : "",
  ]
    .filter(Boolean)
    .join(" ") || "Where you stand on each game you’ve played.";

  const tables = items.map((d) => boardTable(d.board, you, d)).join("");

  const html = `${h2("Leaderboards")}
${para(esc(intro), "font-size:15px;margin-bottom:0;")}
${tables}
<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:${C.muted};">All-time standings by total wins as of Sunday night. Gap is how many more (+) or fewer (−) wins than you.</p>`;

  const text = `
Leaderboards (all-time, by wins): ${intro}
${
    items
      .map((d) => {
        const rows = boardRows(d.board, you)
          .filter((r): r is BoardRow => r !== null)
          .map((r) =>
            `   #${r.rank} ${r.name}${r.you ? " (you)" : ""}: ${plural(r.wins, "win")}, ${
              pct(r.wins, r.games)
            }`
          )
          .join("\n");
        const flag = d.lostLead ? " (lost #1)" : d.close ? " (close race)" : "";
        return `- ${d.board.name}${flag}\n${rows}`;
      })
      .join("\n")
  }
`;

  return { html, text };
}

// ---------------------------------------------------------------------------
// Lost #1 alert
// ---------------------------------------------------------------------------

export function renderLostLead(p: LostLeadPayload, links: Links): RenderedEmail {
  const you = p.screen_name || "You";
  const first = p.games[0];
  const taker = first.leader?.name ?? "Someone";
  const many = p.games.length > 1;

  const subject = many
    ? `You lost #1 in ${listNames(p.games.map((g) => g.name))}`
    : `${taker} took #1 in ${first.name}`;
  const headline = many ? "You lost the top spot" : `${taker} took your #1 spot`;

  const lines = p.games.map((g) => {
    const gap = (g.leader?.wins ?? g.wins) - g.wins;
    const behind = gap === 0 ? "tied on wins" : `${plural(gap, "win")} behind`;
    return `${
      g.leader?.name ?? "Someone"
    } passed you in ${g.name}. You’re now #${g.rank} of ${g.players}, ${behind}.`;
  });

  const tables = p.games
    .map((g) => boardTable(g, you, { lead: false, close: false, lostLead: true }))
    .join("");

  const body = `
${h1(headline)}
${lines.map((line) => para(esc(line))).join("")}
${tables}
<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:${C.muted};">All-time standings by total wins, as of this alert. Gap is how many more (+) or fewer (−) wins than you.</p>
${button(`${links.site}/${first.slug}/`, many ? "Win it back" : `Win back ${first.name}`)}`;

  const why =
    "You’re getting this because you were #1 on a GuyGames leaderboard. We only email when you lose the top spot, at most once a day.";
  const html = layout({
    preheader: lines[0],
    eyebrow: `Leaderboard alert · ${longDate(p.day)}`,
    body,
    footer: footer(links, "lost_lead", p.unsubscribe_token, why),
  });

  const text = `${headline}

${lines.join("\n")}

${p.games.map((g) => `${g.name}:\n${boardText(g, you)}`).join("\n\n")}

Play ${first.name}: ${links.site}/${first.slug}/

${textFooter(links, "lost_lead", p.unsubscribe_token, why.replace(/’/g, "'"))}`;

  return { subject, html, text };
}

function boardText(b: Leaderboard, you: string): string {
  return boardRows(b, you)
    .filter((r): r is BoardRow => r !== null)
    .map((r) =>
      `   #${r.rank} ${r.name}${r.you ? " (you)" : ""}: ${plural(r.wins, "win")}, ${
        pct(r.wins, r.games)
      }`
    )
    .join("\n");
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
