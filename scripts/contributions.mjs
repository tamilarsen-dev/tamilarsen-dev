// scripts/contributions.mjs
//
// Draws the contributions calendar for the profile README, made to look like
// GitHub's own (sizes, greens, labels) — the way the snake cards do it,
// since GitHub's real calendar can't be touched from a README. On it, the
// same idea as the Activity section on tamil-arsen.dev: a packet
// (◆) that travels it in order, hopping from each day with a contribution
// to the next along the grid's lines and leaving the route behind as a
// hairline. It ends on today and rests there with a slow heartbeat.
//
// Writes assets/contributions-dark.svg and assets/contributions-light.svg.
// Run by .github/workflows/contributions.yml once a day; by hand:
//
//   GITHUB_TOKEN=… node scripts/contributions.mjs        (real data)
//   node scripts/contributions.mjs --demo                 (made-up data, to
//                                                          look at the design)
//
// No dependencies: Node 20+ (fetch). Text uses GitHub's system font stack.
// GitHub shows README images through a
// proxy that strips scripts — all motion is CSS inside the SVG, and it
// stands still for prefers-reduced-motion.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOGIN = process.env.GH_LOGIN ?? "tamilarsen-dev";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ── data ─────────────────────────────────────────────────────────────── */

const QUERY = `query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    }
  }
}`;

const LEVEL = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

async function fetchCalendar() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set (or pass --demo)");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "tamilarsen-dev-profile",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  const cal = json.data.user.contributionsCollection.contributionCalendar;
  return {
    total: cal.totalContributions,
    weeks: cal.weeks.map((w) =>
      w.contributionDays.map((d) => ({
        date: d.date,
        count: d.contributionCount,
        level: LEVEL[d.contributionLevel] ?? 0,
      })),
    ),
  };
}

/** A year of made-up days, shaped like a real one (quiet, then busy). */
function demoCalendar() {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 364 - start.getUTCDay());
  const weeks = [];
  let total = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let d = new Date(start); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0) weeks.push([]);
    const daysLeft = (today - d) / 864e5;
    const busy = daysLeft < 40 ? 0.55 : daysLeft < 330 && rnd() < 0.03 ? 1 : 0;
    const count = rnd() < busy ? Math.ceil(rnd() * (daysLeft < 10 ? 16 : 5)) : 0;
    total += count;
    const level = count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : count < 10 ? 3 : 4;
    weeks.at(-1).push({ date: d.toISOString().slice(0, 10), count, level });
  }
  return { total, weeks };
}

function stats(weeks) {
  const days = weeks.flat();
  let longest = 0;
  let run = 0;
  let best = days[0];
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
    if (d.count > best.count) best = d;
  }
  // current streak: today may still be empty — count from yesterday then
  let current = 0;
  let i = days.length - 1;
  if (days[i]?.count === 0) i--;
  for (; i >= 0 && days[i].count > 0; i--) current++;
  return { longest, current, best, today: days.at(-1) };
}

/* ── layout ───────────────────────────────────────────────────────────── */
// Sized and coloured like GitHub's own calendar (10px cells, 3px gaps,
// Primer greens), on a transparent background so it sits on the profile
// page like the real one does.

const CELL = 10;
const STEP = 13;
const GX = 32; // grid left (day labels before it)
const GY = 22; // grid top (month labels above it)
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const THEMES = {
  dark: {
    text: "#9198A1",
    edge: "rgba(240,246,252,0.06)",
    levels: ["#151B23", "#033A16", "#196C2E", "#2EA043", "#56D364"],
    trace: "#56D364",
    halo: "#0D1117",
  },
  light: {
    text: "#59636E",
    edge: "rgba(31,35,40,0.06)",
    levels: ["#EFF2F5", "#ACEEBB", "#4AC26B", "#2DA44E", "#116329"],
    trace: "#1A7F37",
    halo: "#FFFFFF",
  },
};

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDay = (iso) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
const r2 = (n) => Math.round(n * 100) / 100;

/* ── the route ────────────────────────────────────────────────────────── */

const DWELL = 90; // ms on each day
const START = 700; // ms before it sets off
const MAX = 9000; // the whole trip, at most

function route(weeks) {
  const c = (w, d) => ({ x: GX + w * STEP + CELL / 2, y: GY + d * STEP + CELL / 2 });
  const stops = [];
  weeks.forEach((week, w) =>
    week.forEach((day, d) => {
      if (day.count > 0) stops.push({ ...c(w, d), date: day.date });
    }),
  );
  const lastW = weeks.length - 1;
  const today = weeks[lastW].at(-1);
  if (stops.at(-1)?.date !== today.date)
    stops.push({ ...c(lastW, weeks[lastW].length - 1), date: today.date });
  if (stops.length < 2) return null;

  // across to the day's week, then up or down to its day — one corner
  let d = `M${stops[0].x} ${stops[0].y}`;
  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (b.x !== a.x) d += `H${b.x}`;
    if (b.y !== a.y) d += `V${b.y}`;
    legs.push(Math.abs(b.x - a.x) + Math.abs(b.y - a.y));
  }
  const length = legs.reduce((s, l) => s + l, 0);

  // time per hop grows gently with its length; the whole trip is capped
  let hops = legs.map((l) => 120 + Math.sqrt(l) * 24);
  let total = hops.reduce((s, h) => s + h + DWELL, 0);
  if (total > MAX) {
    const k = (MAX - legs.length * DWELL) / hops.reduce((s, h) => s + h, 0);
    hops = hops.map((h) => h * k);
    total = MAX;
  }

  // keyframes: [time %, distance %] — arrive, dwell, leave
  const frames = [[0, 0]];
  const arrive = [0]; // ms each stop is reached
  let t = 0;
  let dist = 0;
  legs.forEach((l, i) => {
    t += hops[i];
    dist += l;
    frames.push([(t / total) * 100, (dist / length) * 100]);
    arrive.push(t);
    t += DWELL;
    frames.push([(t / total) * 100, (dist / length) * 100]);
  });
  return { d, stops, frames, arrive, total };
}

/* ── svg ──────────────────────────────────────────────────────────────── */

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;

function card(cal, theme) {
  const c = THEMES[theme];
  const { weeks, total } = cal;
  const s = stats(weeks);
  const r = route(weeks);
  const gridW = weeks.length * STEP - (STEP - CELL);
  const W = GX + gridW + 2;
  const H = GY + 7 * STEP + 34;
  const out = [];

  // month labels: where a month's first week starts (one that would crowd
  // the label before it is skipped)
  let lastMonth = -1;
  let lastX = -99;
  weeks.forEach((week, w) => {
    const m = Number(week[0].date.slice(5, 7)) - 1;
    if (m !== lastMonth) {
      const x = GX + w * STEP;
      if (x - lastX >= 30 && x + 22 <= GX + gridW) {
        out.push(`<text x="${x}" y="${GY - 9}">${MONTHS[m]}</text>`);
        lastX = x;
      }
      lastMonth = m;
    }
  });
  ["Mon", "Wed", "Fri"].forEach((name, i) =>
    out.push(`<text x="0" y="${GY + (i * 2 + 1) * STEP + 9}">${name}</text>`),
  );

  // cells
  weeks.forEach((week, w) =>
    week.forEach((day, d) => {
      out.push(
        `<rect x="${GX + w * STEP}" y="${GY + d * STEP}" width="${CELL}" height="${CELL}" rx="2" fill="${c.levels[day.level]}" stroke="${c.edge}"><title>${esc(`${day.count === 0 ? "No" : day.count} contribution${day.count === 1 ? "" : "s"} on ${fmtDay(day.date)}`)}</title></rect>`,
      );
    }),
  );

  let motion = "";
  let css = "";
  if (r) {
    const end = r.stops.at(-1);
    const pct = (x) => `${r2(x)}%`;
    const ease = (i) => (i % 2 === 0 ? "cubic-bezier(.65,0,.35,1)" : "linear");
    const kfPacket = r.frames.map(([t, dd], i) => `${pct(t)}{offset-distance:${pct(dd)};animation-timing-function:${ease(i)}}`).join("");
    const kfRoute = r.frames.map(([t, dd], i) => `${pct(t)}{stroke-dashoffset:${r2(1000 - dd * 10)};animation-timing-function:${ease(i)}}`).join("");
    const T = r.total;
    css = `
.route{stroke-dasharray:1000;stroke-dashoffset:1000;animation:draw ${T}ms ${START}ms both,settle 700ms ${START + T}ms both}
@keyframes draw{${kfRoute}}
@keyframes settle{to{opacity:.38}}
.pk{opacity:0}
@supports (offset-path:path("M0 0")){
 .pk{opacity:1;offset-path:path("${r.d}");offset-rotate:0deg;animation:travel ${T}ms ${START}ms both}
}
@keyframes travel{${kfPacket}}
.ring{transform-box:fill-box;transform-origin:center;opacity:0;animation:ping 650ms ease-out both}
@keyframes ping{0%{opacity:.85;transform:scale(.5)}100%{opacity:0;transform:scale(1.9)}}
.beat{transform-box:fill-box;transform-origin:center;opacity:0;animation:beat 3600ms ease-out ${START + T}ms infinite}
@keyframes beat{0%{opacity:.9;transform:scale(.6)}45%,100%{opacity:0;transform:scale(2.4)}}
.today{opacity:0;animation:fade 400ms ${START + T}ms both}
@keyframes fade{to{opacity:1}}
@media (prefers-reduced-motion:reduce){.route,.pk,.ring,.beat{display:none}.today{opacity:1;animation:none}}`;

    const rings = r.stops
      .map((p, i) => `<rect class="ring" x="${p.x - 5}" y="${p.y - 5}" width="10" height="10" rx="2" fill="none" stroke="${c.trace}" stroke-width="1.2" style="animation-delay:${Math.round(START + r.arrive[i])}ms"/>`)
      .join("");
    motion = `
<path class="route" d="${r.d}" pathLength="1000" fill="none" stroke="${c.trace}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
${rings}
<rect class="beat" x="${end.x - 6}" y="${end.y - 6}" width="12" height="12" rx="2" fill="none" stroke="${c.trace}" stroke-width="1.2"/>
<rect class="today" x="${end.x - 7}" y="${end.y - 7}" width="14" height="14" rx="3" fill="none" stroke="${c.trace}" stroke-width="1.2"/>
<g class="pk"><rect x="-3.6" y="-3.6" width="7.2" height="7.2" transform="rotate(45)" fill="${c.trace}" stroke="${c.halo}" stroke-width="1.5"/></g>`;
  }

  const legendX = GX + gridW - 32 - 5 * STEP + (STEP - CELL); // "More" ends at the grid's edge
  const by = H - 9; // bottom row baseline

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${total} contributions in the last year — longest streak ${s.longest} days`)}">
<style>
text{font-family:${FONT};font-size:12px;fill:${c.text}}
${css}
</style>
${out.join("\n")}
${motion}
<text x="${GX}" y="${by}">${total} contributions in the last year · longest streak ${s.longest}d</text>
<text x="${legendX - 6}" y="${by}" text-anchor="end">Less</text>
${c.levels.map((l, i) => `<rect x="${legendX + i * STEP}" y="${by - 9}" width="${CELL}" height="${CELL}" rx="2" fill="${l}" stroke="${c.edge}"/>`).join("")}
<text x="${legendX + 5 * STEP + 3}" y="${by}">More</text>
</svg>
`;
}

/* ── run ──────────────────────────────────────────────────────────────── */

const cal = process.argv.includes("--demo") ? demoCalendar() : await fetchCalendar();
await mkdir(join(ROOT, "assets"), { recursive: true });
for (const theme of ["dark", "light"]) {
  const file = join(ROOT, `assets/contributions-${theme}.svg`);
  await writeFile(file, card(cal, theme));
  console.log(`wrote ${file}`);
}
