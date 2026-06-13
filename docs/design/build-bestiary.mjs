// Generates docs/design/bestiary.html — a visual bestiary of all creatures,
// each rendered inside the in-game "seal" framing (parchment disc, double ink
// ring, gilt tier pips, faction-colored banner notch) using the actual woodcut
// emblem SVGs. Regenerate after adding/altering emblems:
//   node docs/design/build-bestiary.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const creaturesDir = resolve(root, 'src/assets/themes/woodcut/creatures');

const raw = JSON.parse(readFileSync(resolve(root, 'src/data/creatures.json'), 'utf8'));
const creatures = Array.isArray(raw) ? raw : (raw.creatures ?? Object.values(raw));

const FACTIONS = [
  { id: 'castle', name: 'Castle', motto: 'crimson · steel · gilt', notch: '#a32638', band: '#a32638' },
  { id: 'rampart', name: 'Rampart', motto: 'leaf · bark · gilt', notch: '#4e8a3a', band: '#4e8a3a' },
  { id: 'necropolis', name: 'Necropolis', motto: 'bone · violet · grave-green', notch: '#3b2d45', band: '#3b2d45' },
  { id: 'neutral', name: 'Neutral', motto: 'the wandering host', notch: '#718096', band: '#718096' },
];

// --- seal geometry, mirroring SpritePainter (disc r=34 in an 80-box) ---
const C = 40; // disc center x/y
const R = 34; // disc radius
const EMBLEM_SCALE = 1.34;
const EMBLEM_VERT_OFFSET = 0.2;
const EMBLEM_CLIP = 0.92;
const RING_OUTER = R * 0.093;
const RING_INNER_R = R * 0.843;
const RING_INNER_W = R * 0.032;
const PIP_HALF = R * 0.13;
const PIP_GAP = R * 0.36;
const PIP_ARC_Y = R * 0.55;
const PIP_STROKE = R * 0.04;
const NOTCH_HW = R * 0.31;
const NOTCH_TOP = R * 0.66;
const NOTCH_SHOULDER = R * 0.84;
const NOTCH_TIP = R * 0.94;

function emblemInner(id) {
  const svg = readFileSync(resolve(creaturesDir, `${id}.svg`), 'utf8');
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
}

// tier as 1-3 pips in a rising metal (bronze 1-3, silver 4-6, gold 7), matching
// SpritePainter.tierPipSpec — avoids seven pips crowding the rim
const PIP_METAL = ['#a9743b', '#c2ccd6', '#d9ab3c'];
function pips(tier) {
  const t = Math.max(1, Math.min(9, tier));
  const color = PIP_METAL[Math.floor((t - 1) / 3)];
  const n = ((t - 1) % 3) + 1;
  const cy = C + PIP_ARC_Y;
  const total = (n - 1) * PIP_GAP;
  const out = [];
  for (let i = 0; i < n; i++) {
    const cx = C - total / 2 + i * PIP_GAP;
    out.push(
      `<path d="M${cx} ${cy - PIP_HALF} L${cx + PIP_HALF} ${cy} L${cx} ${cy + PIP_HALF} L${cx - PIP_HALF} ${cy} Z" fill="${color}" stroke="#241b16" stroke-width="${PIP_STROKE}" stroke-linejoin="round"/>`,
    );
  }
  return out.join('');
}

function notch(color) {
  const top = C + NOTCH_TOP;
  const sh = C + NOTCH_SHOULDER;
  const tip = C + NOTCH_TIP;
  // a small swallow-tail banner chevron at the bottom of the disc
  const d = `M${C - NOTCH_HW} ${top} L${C + NOTCH_HW} ${top} L${C + NOTCH_HW} ${sh} L${C} ${tip} L${C - NOTCH_HW} ${sh} Z`;
  return `<path d="${d}" fill="${color}" stroke="#241b16" stroke-width="${R * 0.057}" stroke-linejoin="round"/>`;
}

function seal(id, tier, notchColor) {
  const side = R * EMBLEM_SCALE;
  const scale = side / 64;
  const ecx = C;
  const ecy = C - R * EMBLEM_VERT_OFFSET;
  const tx = ecx - 32 * scale;
  const ty = ecy - 32 * scale;
  const clipR = R * EMBLEM_CLIP;
  const cid = `clip-${id}`;
  return `<svg viewBox="0 0 80 80" class="seal" role="img" aria-label="${id}">
  <defs><clipPath id="${cid}"><circle cx="${C}" cy="${C}" r="${clipR}"/></clipPath></defs>
  <circle cx="${C}" cy="${C}" r="${R}" fill="#ead9b5"/>
  <g clip-path="url(#${cid})"><g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">${emblemInner(id)}</g></g>
  <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="#241b16" stroke-width="${RING_OUTER}"/>
  <circle cx="${C}" cy="${C}" r="${RING_INNER_R}" fill="none" stroke="#c9b384" stroke-width="${RING_INNER_W}"/>
  ${pips(tier)}
  ${notch(notchColor)}
</svg>`;
}

const FLAG_LABEL = { flying: 'Flying', wide: 'Wide', undead: 'Undead' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

function card(c, notchColor) {
  const flags = (c.flags ?? []).map((f) => `<span class="flag">${FLAG_LABEL[f] ?? f}</span>`).join('');
  const stats = [
    ['ATK', c.attack],
    ['DEF', c.defense],
    ['HP', c.hp],
    ['SPD', c.speed],
    ['DMG', `${c.dmgMin}–${c.dmgMax}`],
  ]
    .map(([k, v]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join('');
  return `<figure class="card">
    <div class="art">${seal(c.id, c.tier, notchColor)}</div>
    <figcaption>
      <div class="tier">Tier ${ROMAN[c.tier] ?? c.tier}</div>
      <h3>${c.name}</h3>
      <div class="flags">${flags || '<span class="flag none">—</span>'}</div>
      <div class="stats">${stats}</div>
    </figcaption>
  </figure>`;
}

const sections = FACTIONS.map((f) => {
  const members = creatures
    .filter((c) => c.faction === f.id)
    .sort((a, b) => a.tier - b.tier);
  const cards = members.map((c) => card(c, f.notch)).join('\n');
  return `<section class="faction" id="${f.id}">
    <div class="band" style="background:${f.band}"></div>
    <div class="fhead">
      <h2>${f.name}</h2>
      <span class="motto">${f.motto}</span>
      <span class="tally">${members.length} creatures</span>
    </div>
    <div class="grid">${cards}</div>
  </section>`;
}).join('\n');

const total = creatures.length;
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Open Heroes — Bestiary · Gilded Woodcut</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Grenze+Gotisch:wght@400;600;800&family=Alegreya:ital,wght@0,400;0,500;0,700;1,400&family=Alegreya+SC:wght@500;700&display=swap" rel="stylesheet">
<style>
  :root{--ink:#241b16;--night:#16100c;--night2:#1f1812;--parch:#ece0c4;--parch2:#ddcba1;--edge:#c9b384;--gold:#c9a13b;--gold2:#e8c75e;--golddeep:#9a7322;}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--night);color:var(--parch);font-family:'Alegreya',Georgia,serif;font-size:17px;line-height:1.6}
  body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:50;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='0.05'/%3E%3C/svg%3E")}
  .wrap{max-width:1180px;margin:0 auto;padding:0 32px}
  header{padding:76px 0 40px;text-align:center}
  .kicker{font-family:'Alegreya SC',serif;font-weight:700;letter-spacing:.42em;text-transform:uppercase;font-size:13px;color:var(--gold)}
  h1{font-family:'Grenze Gotisch',serif;font-weight:800;font-size:clamp(56px,9vw,108px);line-height:.92;margin:14px 0 6px;text-shadow:0 4px 0 rgba(0,0,0,.55)}
  h1 .gilt{color:var(--gold2)}
  .subtitle{font-style:italic;font-size:20px;color:#b8a583;max-width:640px;margin:12px auto 0}
  .legend{display:flex;gap:26px;justify-content:center;flex-wrap:wrap;margin:30px auto 0;max-width:760px;font-size:14.5px;color:#c4b291}
  .legend b{color:var(--parch)}
  .rule{display:flex;align-items:center;gap:16px;justify-content:center;margin:34px 0 0}
  .rule::before,.rule::after{content:'';height:1px;width:180px;background:linear-gradient(90deg,transparent,var(--gold))}
  .rule::after{background:linear-gradient(90deg,var(--gold),transparent)}
  .rule span{font-family:'Alegreya SC',serif;letter-spacing:.2em;color:var(--gold);font-size:13px}
  .faction{padding:30px 0 10px}
  .band{height:8px;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.4)}
  .fhead{display:flex;align-items:baseline;gap:18px;margin:16px 0 22px}
  .fhead h2{font-family:'Grenze Gotisch',serif;font-weight:600;font-size:46px;line-height:1;color:var(--parch)}
  .fhead .motto{font-style:italic;color:#a08a63}
  .fhead .tally{margin-left:auto;font-family:'Alegreya SC',serif;letter-spacing:.16em;font-size:12.5px;color:#8a7355;text-transform:uppercase}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(186px,1fr));gap:20px}
  .card{background:radial-gradient(120% 90% at 30% 0%,#f4ead2 0%,var(--parch) 45%,var(--parch2) 100%);border:1px solid var(--edge);outline:3px solid var(--night2);box-shadow:0 0 0 4px var(--golddeep),0 16px 34px -16px rgba(0,0,0,.8);padding:16px 16px 18px;text-align:center}
  .art{display:flex;justify-content:center}
  .seal{width:128px;height:128px;display:block;filter:drop-shadow(0 3px 4px rgba(20,14,10,.3))}
  figcaption{margin-top:6px;color:var(--ink)}
  .tier{font-family:'Alegreya SC',serif;font-weight:700;letter-spacing:.18em;font-size:11.5px;color:var(--golddeep);text-transform:uppercase}
  .card h3{font-family:'Grenze Gotisch',serif;font-weight:600;font-size:25px;line-height:1.05;color:var(--ink);margin:2px 0 6px}
  .flags{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;min-height:20px}
  .flag{font-family:'Alegreya SC',serif;font-weight:700;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:#6e5328;border:1px solid rgba(110,83,40,.5);border-radius:3px;padding:1px 6px}
  .flag.none{border:none;color:#b09a6e}
  .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:2px;margin-top:11px;border-top:1px solid rgba(110,83,40,.3);padding-top:9px}
  .stat{display:flex;flex-direction:column;line-height:1.15}
  .stat .k{font-family:'Alegreya SC',serif;font-size:9px;letter-spacing:.06em;color:#8a6f3f}
  .stat .v{font-size:14px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
  footer{padding:54px 0 80px;text-align:center;color:#8a7355;font-style:italic}
  @media(max-width:560px){.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
</style>
</head>
<body>
<header>
  <div class="wrap">
    <div class="kicker">Open Heroes · Gilded Woodcut</div>
    <h1>The <span class="gilt">Bestiary</span></h1>
    <p class="subtitle">All ${total} creatures, each struck as a seal: the emblem within the
    parchment disc, gilt pips counting its tier, the banner notch its allegiance.</p>
    <div class="legend">
      <span><b>Emblem</b> — the creature's woodcut mark</span>
      <span><b>◆ Pips</b> — tier: bronze I–III · silver IV–VI · gold VII</span>
      <span><b>Banner notch</b> — faction color</span>
    </div>
    <div class="rule"><span>51 Pieces</span></div>
  </div>
</header>
<main class="wrap">
${sections}
</main>
<footer class="wrap">Open Heroes · Bestiary generated from the woodcut theme emblems · no animation</footer>
</body>
</html>`;

writeFileSync(resolve(here, 'bestiary.html'), html);
console.log(`wrote docs/design/bestiary.html — ${total} creatures across ${FACTIONS.length} factions`);
