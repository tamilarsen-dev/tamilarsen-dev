// scripts/contributions.mjs
//
// Draws the contributions card for the profile README — the same idea as
// the Activity section on tamil-arsen.dev: the year as a grid, and a packet
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
// No dependencies: Node 20+ (fetch). Fonts are IBM Plex (OFL), embedded so
// the card looks the same everywhere. GitHub shows README images through a
// proxy that strips scripts — all motion is CSS inside the SVG, and it
// stands still for prefers-reduced-motion.

import { readFile, writeFile, mkdir } from "node:fs/promises";
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

const W = 1280;
const H = 318;
const PAD = 64;
const CELL = 14;
const STEP = 18;
const GX = PAD + 40; // grid left (day labels before it)
const GY = 120; // grid top
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const THEMES = {
  dark: {
    bg: "#141414",
    fg: "#F4F4F5",
    muted: "#A1A1AA",
    subtle: "#84848C",
    faint: "#5A5A62",
    line: "#F4F4F5",
    accent: "#B33A47",
    accentText: "#CE6A75",
    ok: "#22C55E",
    okBg: "rgba(34,197,94,0.14)",
    getBg: "rgba(179,58,71,0.16)",
    levels: ["#222225", "#4A2328", "#76303A", "#A63D4B", "#D9707C"],
  },
  light: {
    bg: "#F5F4F2",
    fg: "#18181B",
    muted: "#52525B",
    subtle: "#71717A",
    faint: "#A1A1AA",
    line: "#18181B",
    accent: "#B33A47",
    accentText: "#8E2A36",
    ok: "#15803D",
    okBg: "rgba(21,128,61,0.12)",
    getBg: "rgba(179,58,71,0.12)",
    levels: ["#E6E3DE", "#EBC3C7", "#DC8B95", "#C4505E", "#8E2A36"],
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

async function fontFaces() {
  const face = async (family, file, weight) => {
    const b64 = (await readFile(join(ROOT, "scripts/fonts", file))).toString("base64");
    return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:${weight}}`;
  };
  return (
    await Promise.all([
      face("mono", "IBMPlexMono-400.woff2", 400),
      face("mono", "IBMPlexMono-500.woff2", 500),
      face("sansB", "IBMPlexSans-700.woff2", 700),
    ])
  ).join("");
}

function card(cal, theme, fonts) {
  const c = THEMES[theme];
  const { weeks, total } = cal;
  const s = stats(weeks);
  const r = route(weeks);
  const gridW = weeks.length * STEP - (STEP - CELL);
  const out = [];

  // month labels: where a month's first week starts
  let lastMonth = -1;
  weeks.forEach((week, w) => {
    const m = Number(week[0].date.slice(5, 7)) - 1;
    if (m !== lastMonth && w < weeks.length - 1) {
      if (lastMonth !== -1 || week[0].date.slice(8) <= "07")
        out.push(`<text x="${GX + w * STEP}" y="${GY - 14}" class="m t11" fill="${c.subtle}">${MONTHS[m]}</text>`);
      lastMonth = m;
    }
  });
  ["Mon", "Wed", "Fri"].forEach((name, i) =>
    out.push(`<text x="${PAD}" y="${GY + (i * 2 + 1) * STEP + 11}" class="m t11" fill="${c.faint}">${name}</text>`),
  );

  // cells
  weeks.forEach((week, w) =>
    week.forEach((day, d) => {
      out.push(
        `<rect x="${GX + w * STEP}" y="${GY + d * STEP}" width="${CELL}" height="${CELL}" rx="3" fill="${c.levels[day.level]}"><title>${esc(`${day.count} on ${fmtDay(day.date)}`)}</title></rect>`,
      );
    }),
  );

  let motion = "";
  let css = "";
  if (r) {
    const end = r.stops.at(-1);
    const pct = (x) => `${r2(x)}%`;
    const kfPacket = r.frames
      .map(([t, dd], i) => `${pct(t)}{offset-distance:${pct(dd)};animation-timing-function:${i % 2 === 0 ? "cubic-bezier(.65,0,.35,1)" : "linear"}}`)
      .join("");
    const kfRoute = r.frames
      .map(([t, dd], i) => `${pct(t)}{stroke-dashoffset:${r2(1000 - dd * 10)};animation-timing-function:${i % 2 === 0 ? "cubic-bezier(.65,0,.35,1)" : "linear"}}`)
      .join("");
    const T = r.total;
    css = `
.route{stroke-dasharray:1000;stroke-dashoffset:1000;animation:draw ${T}ms ${START}ms both,settle 700ms ${START + T}ms both}
@keyframes draw{${kfRoute}}
@keyframes settle{to{opacity:.42}}
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
      .map((p, i) => `<rect class="ring" x="${p.x - 7}" y="${p.y - 7}" width="14" height="14" rx="3" fill="none" stroke="${c.accentText}" stroke-width="1.5" style="animation-delay:${Math.round(START + r.arrive[i])}ms"/>`)
      .join("");
    motion = `
<path class="route" d="${r.d}" pathLength="1000" fill="none" stroke="${c.accentText}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
${rings}
<rect class="beat" x="${end.x - 8}" y="${end.y - 8}" width="16" height="16" rx="3" fill="none" stroke="${c.accentText}" stroke-width="1.5"/>
<rect class="today" x="${end.x - 9}" y="${end.y - 9}" width="18" height="18" rx="4" fill="none" stroke="${c.accentText}" stroke-width="1.5"/>
<g class="pk"><rect x="-5" y="-5" width="10" height="10" transform="rotate(45)" fill="${c.accentText}" stroke="${c.bg}" stroke-width="2"/></g>`;
  }

  const activeToday = s.today.count > 0;
  const statusText = activeToday ? "ACTIVE TODAY" : `LAST ACTIVE · ${fmtDay([...weeks.flat()].reverse().find((d) => d.count > 0)?.date ?? s.today.date).toUpperCase()}`;
  const legendX = GX + gridW - 5 * 18;
  const sx = GX + gridW + 56; // stats column

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${total} contributions in the last year — longest streak ${s.longest} days`)}">
<style>${fonts}
.m{font-family:'mono',ui-monospace,monospace}.b{font-family:'sansB',system-ui,sans-serif;font-weight:700}
.t11{font-size:11px;letter-spacing:.06em}.t13{font-size:13px}.t15{font-size:15px}.cap{font-size:11px;letter-spacing:.16em}
${css}
</style>
<rect width="${W}" height="${H}" rx="12" fill="${c.bg}"/>

<g class="m t15">
  <rect x="${PAD}" y="38" width="46" height="26" rx="13" fill="${c.getBg}"/>
  <text x="${PAD + 23}" y="56" text-anchor="middle" fill="${c.accentText}" font-weight="500" class="t13">GET</text>
  <text x="${PAD + 60}" y="56" fill="${c.subtle}">/users/<tspan fill="${c.fg}">${esc(LOGIN)}</tspan>/contributions</text>
  <rect x="${PAD + 60 + (21 + LOGIN.length) * 9 + 12}" y="38" width="46" height="26" rx="13" fill="${c.okBg}"/>
  <text x="${PAD + 60 + (21 + LOGIN.length) * 9 + 35}" y="56" text-anchor="middle" fill="${c.ok}" font-weight="500" class="t13">200</text>
</g>
<g class="m cap" fill="${activeToday ? c.ok : c.subtle}">
  <circle cx="${W - PAD - statusText.length * 8.4 - 14}" cy="51" r="4" fill="${activeToday ? c.ok : c.faint}"/>
  <text x="${W - PAD}" y="55" text-anchor="end">${esc(statusText)}</text>
</g>

${out.join("\n")}
${motion}

<g>
  <text x="${sx}" y="${GY + 34}" class="b" font-size="46" fill="${c.fg}">${total}</text>
  <text x="${sx}" y="${GY + 58}" class="m t13" fill="${c.muted}">contributions</text>
  <text x="${sx}" y="${GY + 76}" class="m t13" fill="${c.subtle}">last year</text>
  <text x="${sx}" y="${GY + 108}" class="m cap" fill="${c.subtle}">STREAK</text>
  <text x="${sx + 70}" y="${GY + 108}" class="m t13" fill="${c.fg}">${s.current}d</text>
  <text x="${sx}" y="${GY + 128}" class="m cap" fill="${c.subtle}">LONGEST</text>
  <text x="${sx + 70}" y="${GY + 128}" class="m t13" fill="${c.fg}">${s.longest}d</text>
</g>

<g class="m">
  <text x="${GX}" y="${H - 36}" class="cap" fill="${c.subtle}">BEST DAY · <tspan fill="${c.fg}">${esc(fmtDay(s.best.date).toUpperCase())} · ${s.best.count}</tspan></text>
  <text x="${legendX - 10}" y="${H - 36}" class="t11" text-anchor="end" fill="${c.subtle}">Less</text>
  ${c.levels.map((l, i) => `<rect x="${legendX + i * 18}" y="${H - 47}" width="${CELL}" height="${CELL}" rx="3" fill="${l}"/>`).join("")}
  <text x="${legendX + 5 * 18 + 6}" y="${H - 36}" class="t11" fill="${c.subtle}">More</text>
</g>
</svg>
`;
}

/* ── run ──────────────────────────────────────────────────────────────── */

const cal = process.argv.includes("--demo") ? demoCalendar() : await fetchCalendar();
const fonts = await fontFaces();
await mkdir(join(ROOT, "assets"), { recursive: true });
for (const theme of ["dark", "light"]) {
  const file = join(ROOT, `assets/contributions-${theme}.svg`);
  await writeFile(file, card(cal, theme, fonts));
  console.log(`wrote ${file}`);
}
