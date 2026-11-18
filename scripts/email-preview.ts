/**
 * Render the player emails to local HTML files for a look before sending.
 *
 *   deno run --allow-read --allow-write scripts/email-preview.ts [payloads.json] [out-dir]
 *
 * payloads.json is { "weekly": [WeeklyPayload…], "missed": [MissedYouPayload…],
 * "lost": [LostLeadPayload…] }.
 * Defaults to scripts/email-preview-fixtures.json (made-up players) and
 * _email-preview/ (gitignored). Open <out-dir>/index.html.
 */
import {
  type LostLeadPayload,
  type MissedYouPayload,
  type RenderedEmail,
  renderLostLead,
  renderMissedYou,
  renderWeeklySummary,
  type WeeklyPayload,
} from "../supabase/functions/_shared/email-templates.ts";

const here = new URL(".", import.meta.url).pathname;
const input = Deno.args[0] ?? `${here}email-preview-fixtures.json`;
const outDir = Deno.args[1] ?? `${here}../_email-preview`;
const links = { site: "https://guygames.net" };

const data = JSON.parse(await Deno.readTextFile(input)) as {
  weekly?: WeeklyPayload[];
  missed?: MissedYouPayload[];
  lost?: LostLeadPayload[];
};

const emails: { file: string; label: string; email: RenderedEmail }[] = [];
const slug = (s: string | null) => (s || "player").toLowerCase().replace(/[^a-z0-9]+/g, "-");

for (const payload of data.weekly ?? []) {
  emails.push({
    file: `weekly-${slug(payload.screen_name)}.html`,
    label: `Weekly summary · ${payload.screen_name}`,
    email: renderWeeklySummary(payload, links),
  });
}
for (const payload of data.missed ?? []) {
  emails.push({
    file: `missed-you-${slug(payload.screen_name)}.html`,
    label: `We’ve missed you · ${payload.screen_name}`,
    email: renderMissedYou(payload, links),
  });
}

for (const payload of data.lost ?? []) {
  emails.push({
    file: `lost-lead-${slug(payload.screen_name)}-${payload.day}.html`,
    label: `Lost #1 · ${payload.screen_name} · ${payload.day}`,
    email: renderLostLead(payload, links),
  });
}

await Deno.mkdir(outDir, { recursive: true });
for (const { file, email } of emails) {
  await Deno.writeTextFile(`${outDir}/${file}`, email.html);
  await Deno.writeTextFile(`${outDir}/${file.replace(/\.html$/, ".txt")}`, `Subject: ${email.subject}\n\n${email.text}`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const cards = emails
  .map(
    ({ file, label, email }) => `<section>
  <h2>${esc(label)}</h2>
  <p class="subject"><b>Subject:</b> ${esc(email.subject)} · <a href="${file}">open</a> · <a href="${file.replace(/\.html$/, ".txt")}">plain text</a></p>
  <div class="frames">
    <figure><figcaption>Desktop</figcaption><iframe src="${file}" width="640" height="1100"></iframe></figure>
    <figure><figcaption>Phone</figcaption><iframe src="${file}" width="375" height="1100"></iframe></figure>
  </div>
</section>`,
  )
  .join("\n");

await Deno.writeTextFile(
  `${outDir}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>Email previews</title>
<style>
  body { margin: 0; padding: 24px; font: 15px system-ui, sans-serif; background: #eceae4; color: #19201d; }
  section { margin-bottom: 40px; }
  h2 { margin: 0 0 4px; font-size: 18px; }
  .subject { margin: 0 0 12px; }
  .frames { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
  figure { margin: 0; }
  figcaption { font-size: 12px; color: #666; margin-bottom: 4px; }
  iframe { border: 1px solid #ccc; border-radius: 8px; background: #fff; }
</style>
<h1>Email previews</h1>
${cards}`,
);

console.log(`Wrote ${emails.length} emails to ${outDir}/index.html`);
