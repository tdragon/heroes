# Heroes of Might & Magic 3 Browser Clone

## Overview

Build a browser-based, single-player clone of the 1999 turn-based strategy game *Heroes of Might and Magic III*. The player controls heroes who explore an adventure map, collect resources, capture mines and towns, build up towns, recruit creature armies, learn spells, and fight tactical hex-grid battles against AI opponents until all enemies are eliminated.

This plan is **self-contained**: every game rule, formula, data table, and screen needed to implement the game is specified below. A developer who has never seen the original can implement it from this document alone.

**Scope decisions (defaults chosen, change here if needed):**
- Single-player vs 1–3 AI opponents + local hotseat. **No network multiplayer.**
- MVP ships 3 of 9 factions (Castle, Rampart, Necropolis). The engine is fully data-driven so the other 6 factions are added later by writing JSON data only, no code.
- One map level (no underground), no random map generator, no Grail quest — listed as post-MVP stretch.
- All art is **original placeholder art** (colored geometric tokens, labels). The original game's assets, music, and text are copyrighted and must never be copied. Game *mechanics* are not copyrightable; this is a clean-room mechanical clone.

## Context (from discovery)

- Project directory `/Users/tikhdm/sources/private/heroes` is empty — greenfield. Git repo initialized (branch `heroes3-browser-clone`), Task 1 scaffolding done.
- No existing code, conventions, or CI to conform to.
- User constraints from global CLAUDE.md apply: modern TS/Python typing style, fix linter errors properly, minimal comments.

## Development Approach

- **Testing approach**: Regular (code first, then tests in the same task) — every task ends with passing tests.
- Complete each task fully before moving to the next; make small, focused changes.
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional — they are a required part of the checklist
  - unit tests for new and modified functions, covering success and error scenarios
- **CRITICAL: all tests must pass before starting next task** — no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- The game core (`src/core/`, `src/data/`) must stay **pure TypeScript with zero DOM/browser dependencies** — this is what makes the whole game unit-testable.
- All randomness flows through one seeded PRNG inside `GameState`; same seed + same commands ⇒ identical game. Never call `Math.random()` in core.

## Testing Strategy

- **Unit tests (Vitest)**: required for every task. Core engine is pure functions over a serializable `GameState`, so tests are plain input→output assertions, no mocks needed.
- **Golden replay tests**: scripted command sequences executed against fixture maps; assert the resulting state snapshot. Catches any regression in cross-system interactions.
- **Invariant/property tests**: damage formula bounds, pathfinding optimality, state serialization round-trips — run over randomized seeds.
- **E2E tests (Playwright)**: drive the real browser UI — start game, move hero, fight a battle, build a structure, recruit, win the game. UI changes must add/update e2e tests in the same task; same rigor as unit tests.
- **Coverage**: target ≥80% lines in `src/core/`. UI render code is exercised by e2e, not coverage-gated.
- Commands: `npm test` (Vitest), `npm run test:e2e` (Playwright), `npm run check` (tsc + eslint + tests).

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope

## Solution Overview

### Architecture

```
src/
  core/        pure game logic — no DOM, no rendering, fully deterministic
    state.ts        GameState, serialization
    rng.ts          seeded PRNG (mulberry32)
    commands.ts     Command types + dispatcher (reducer pattern)
    turn.ts         day/week/month cycle, income
    hero.ts         stats, experience, leveling, skills, army
    movement.ts     A* pathfinding, movement points, terrain costs
    objects.ts      adventure-map object interactions
    town.ts         building, recruiting, mage guild
    combat/         battle engine (own sub-state machine)
    magic.ts        mana, spellbook, spell effects
    fog.ts          fog of war / shroud
    ai/             AI player
    victory.ts      win/loss evaluation
  data/        JSON game data + zod schemas + loader
    factions/  castle.json, rampart.json, necropolis.json
    creatures.json  spells.json  artifacts.json  buildings.json
    objects.json    terrain.json  heroes.json  skills.json
  maps/        map JSON format, ASCII map DSL compiler, sample maps
  render/      Canvas 2D renderers (adventure, combat) + sprite/token painter
  ui/          DOM overlay screens (town, hero, dialogs, HUD) — vanilla TS
  app/         game shell: main menu, screen router, save/load, input
```

### Key design decisions

1. **Command/reducer core.** All gameplay is `dispatch(state, command) → newState (+ events)`. Commands: `MoveHero`, `EndTurn`, `Build`, `Recruit`, `CombatAction`, `CastSpell`, … The UI and the AI both emit commands; the core doesn't know who's playing. This gives free: unit testing, replays, save/load, hotseat, and a future network layer.
2. **Data-driven content.** Creatures, buildings, spells, artifacts, factions, map objects are JSON validated by zod schemas at load. Code references content only by string id. Adding a faction = adding JSON.
3. **Canvas 2D + DOM overlay.** The tile map and battlefield are drawn on `<canvas>` (simple, fast enough, no engine dependency). Menus, town screen, dialogs are plain DOM — far easier for text-heavy UI and e2e-testable via selectors.
4. **Placeholder art system.** A single `tokenPainter` draws every entity as a rounded shape: faction-colored disc with creature initials + tier number, terrain as flat colors with subtle noise, buildings as labeled cards. The game is fully playable and readable without any drawn assets; real art can be swapped in later behind one interface.

---

# GAME SPECIFICATION (reference — the "what to build")

Everything below describes the game itself. Numbers marked *(data)* live in JSON files; matching the original exactly is **not** required — internal consistency is. Treat the JSON files as the source of truth once created.

## 1. Game concepts and loop

- A game happens on an **adventure map** (square tile grid) between 2–4 **players** (1 human + AI). Each player has a color, a faction, and starts with one **town** and one **hero**.
- Time advances in **days**. 7 days = a week, 4 weeks = a month. All players take their full turn each day in order (human first by default).
- During a turn a player may, in any order: move heroes (limited by movement points), interact with map objects, manage towns (build max **1 building per town per day**, recruit any number of creatures), cast adventure spells, then **end turn**.
- **Each day** at dawn: players receive income (town gold + mines), heroes regain movement and +1 mana (more with Mysticism).
- **Each week** (day 1 of week): creature dwellings in towns and on the map add their weekly **growth** to their available pool. Show a "new week" banner.
- **Win condition (default)**: eliminate all enemies — capture every enemy town and defeat every enemy hero. **Loss**: lose all your towns and heroes, or hold zero towns for 7 consecutive days while having heroes. Maps may override with special conditions (post-MVP).

## 2. Resources *(data: terrain.json/objects.json)*

| Resource | Use | Mine income/day |
|---|---|---|
| Gold | everything | Gold Mine: 1000 |
| Wood | buildings | Sawmill: 2 |
| Ore | buildings | Ore Pit: 2 |
| Mercury | high buildings, T7 units, magic | Alchemist Lab: 1 |
| Sulfur | same | Sulfur Dune: 1 |
| Crystal | same | Crystal Cavern: 1 |
| Gems | same | Gem Pond: 1 |

Starting resources (normal difficulty): 20000 gold, 20 wood, 20 ore, 5 of each rare. Mines are map objects: flag one by moving a hero onto it (fight guards if any); it pays the owner daily.

## 3. Heroes

A hero is the player's avatar on the map: has a class, primary stats, secondary skills, an army (up to **7 creature stacks**), artifacts, a spellbook with mana, movement points, and experience.

### 3.1 Primary stats

- **Attack** — added to every army stack's attack in combat.
- **Defense** — added to every stack's defense.
- **Spell Power** — scales spell magnitude and duration (duration in rounds = Spell Power).
- **Knowledge** — max mana = Knowledge × 10.

### 3.2 Hero classes *(data: heroes.json)*

Two classes per faction (might-oriented and magic-oriented). MVP classes:

| Class | Faction | Start A/D/SP/K | Level-up stat chance A/D/SP/K (lvl 2–9) | (lvl 10+) |
|---|---|---|---|---|
| Knight | Castle | 2/2/1/1 | 35/45/10/10 % | 30/30/20/20 |
| Cleric | Castle | 1/0/2/2 | 20/15/30/35 % | 20/20/30/30 |
| Ranger | Rampart | 1/3/1/1 | 35/45/10/10 % | 30/30/20/20 |
| Druid | Rampart | 0/2/1/2 | 15/20/30/35 % | 20/20/30/30 |
| Death Knight | Necropolis | 1/2/2/1 | 30/30/20/20 % | 25/25/25/25 |
| Necromancer | Necropolis | 1/0/2/2 | 15/15/35/35 % | 25/25/25/25 |

Each faction's tavern/starting roster has 4+ named hero templates per class *(data)*: name, portrait token, starting secondary skill(s), starting army (e.g. Knight "Edric": Basic Leadership + Basic Armorer, 10–20 Pikemen + 4–7 Archers).

### 3.3 Experience and leveling

XP from battles (sum of defeated creatures' AI value ≈ their HP×2 *(data)*), chests, map objects. Level thresholds: level 2 = 1000, then each next requirement ×~1.2 rounded: 1000, 2000, 3200, 4600, 6200, 8000, 10000, 12200, 14700, 17500, … *(generate table to level 30 in data)*.

On level-up: +1 primary stat rolled by class table above, **plus a choice of one of two offered secondary skills** (one upgrade of an existing skill, one new skill, drawn from class-weighted pool; if hero already has 8 skills, only upgrades are offered). Show a modal with the two options.

### 3.4 Secondary skills *(data: skills.json)*

Each skill has 3 ranks: Basic / Advanced / Expert. A hero holds max **8** skills. MVP set (16):

| Skill | Basic / Advanced / Expert effect |
|---|---|
| Logistics | +10/20/30% movement points on land |
| Pathfinding | reduce terrain penalty by 25/50/75% |
| Scouting | +1/2/3 sight radius |
| Archery | ranged damage +10/25/50% |
| Offense | melee damage +10/20/30% |
| Armorer | damage taken −5/−10/−15% |
| Leadership | morale +1/2/3 |
| Luck | luck +1/2/3 |
| Wisdom | can learn spells of level 3/4/5 (without it: max level 2) |
| Intelligence | max mana +25/50/100% |
| Mysticism | mana regen 2/3/4 per day (base 1) |
| Air Magic | air spells cast at Advanced/Expert tier, cheaper −? no: tier only (see §6) |
| Earth Magic | earth spells at higher tier |
| Fire Magic | fire spells at higher tier |
| Water Magic | water spells at higher tier |
| Necromancy | after victory, raise 10/20/30% of enemy losses (by HP) as Skeletons |

### 3.5 Movement

- Daily movement points = base 1500 + min(army speed bonus): MP = 1300 + 100 × min(speed of slowest creature in army, 11)? — **Simplified rule (use this):** `MP = 1500 + 50 × (slowest creature speed)`, then × Logistics bonus. Recompute at dawn.
- Moving 1 tile costs the **destination tile's terrain cost** *(data: terrain.json)*: dirt/grass 100, sand/snow/swamp/rough/lava: 150/150/175/125/100... use: grass 100, dirt 100, sand 150, snow 150, swamp 175, rough 125, lava 100. Diagonal step ×1.414 (round). **Road on tile overrides**: dirt road 75, gravel 65, cobblestone 50. Pathfinding penalty reduced by Pathfinding skill toward 100 floor.
- Water is impassable (boats are post-MVP stretch).
- Pathfinding: A* over passable tiles; UI shows the path with per-day reach markers; clicking the same destination again confirms and moves until MP exhausted or an interaction triggers.

### 3.6 Hero acquisition

Towns with a Tavern offer 2 random heroes for hire at **2500 gold** each (refresh weekly, never your duplicates). Max 8 heroes per player. Defeated heroes return to the global tavern pool.

## 4. Creatures *(data: creatures.json)*

A creature stack = (creature id, count). Stats per creature:

- **Attack / Defense** — combat modifiers (see damage formula §7.5)
- **Damage min–max** — per single creature
- **HP** — per single creature; stack HP pool = top creature partial HP + full HP × rest
- **Speed** — hexes per combat round; also drives turn order and army MP
- **Growth** — recruits/week in its dwelling
- **Cost** — gold (+ rare resource for tier 7)
- **Flags/abilities** — `ranged(shots)`, `flying`, `wide` (occupies 2 hexes), `undead`, and named specials below

### 4.1 Castle (faction color blue; alignment good)

| T | Name → Upgrade | A | D | Dmg | HP | Spd | Gr | Cost | Special |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Pikeman → Halberdier | 4→6 | 5→5 | 1–3→2–3 | 10 | 4→5 | 14 | 60→75 | — |
| 2 | Archer → Marksman | 6 | 3 | 2–3 | 10 | 4→6 | 9 | 100→150 | ranged(12→24); Marksman: double shot |
| 3 | Griffin → Royal Griffin | 8→9 | 8→9 | 3–6 | 25 | 6→9 | 7 | 200→240 | flying, wide; retaliates 2×→unlimited |
| 4 | Swordsman → Crusader | 10→12 | 12 | 6–9→7–10 | 35 | 5→6 | 4 | 300→400 | Crusader: attacks twice |
| 5 | Monk → Zealot | 12 | 7→10 | 10–12 | 30 | 5→7 | 3 | 400→450 | ranged(12); Zealot: no melee penalty |
| 6 | Cavalier → Champion | 15→16 | 15→16 | 15–25→20–25 | 100 | 7→9 | 2 | 1000→1200 | wide; jousting: +5% dmg per hex traveled |
| 7 | Angel → Archangel | 20→30 | 20→30 | 50 | 200→250 | 12→18 | 1 | 3000+1gem→5000+3gem | flying; Archangel: +1 morale to army, can resurrect 100 HP×count once/battle |

### 4.2 Rampart (green; good)

| T | Name → Upgrade | A | D | Dmg | HP | Spd | Gr | Cost | Special |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Centaur → Centaur Captain | 5→6 | 3 | 2–3 | 8→10 | 6→8 | 14 | 70→90 | wide |
| 2 | Dwarf → Battle Dwarf | 6→7 | 7 | 2–4 | 20 | 3→5 | 8 | 120→150 | magic resistance 20%→40% |
| 3 | Wood Elf → Grand Elf | 9 | 5 | 3–5 | 15 | 6→7 | 7 | 200→225 | ranged(24); Grand Elf: double shot |
| 4 | Pegasus → Silver Pegasus | 9 | 8→10 | 5–9 | 30 | 8→12 | 5 | 250→275 | flying, wide; enemy spells cost +2 mana |
| 5 | Dendroid Guard → Soldier | 9 | 12 | 10–14 | 55→65 | 3→4 | 3 | 350→425 | binds melee target in place |
| 6 | Unicorn → War Unicorn | 15 | 14 | 18–22 | 90→110 | 7→9 | 2 | 850→950 | wide; 20% chance attack blinds; aura: adjacent allies +20% magic resist |
| 7 | Green Dragon → Gold Dragon | 18→27 | 18→27 | 40–50 | 180→250 | 10→16 | 1 | 2400+1cr→4000+2cr | flying, wide; breath (hits 2 hexes); immune to spell levels 1–3→1–4 |

### 4.3 Necropolis (black/teal; evil, undead)

All Necropolis creatures have `undead`: always neutral morale, immune to mind spells (Blind, Berserk), Bless/Curse have no effect, healed by Death Ripple? no — *take no damage from Death Ripple*; can be Animated (resurrected) by Animate Dead only.

| T | Name → Upgrade | A | D | Dmg | HP | Spd | Gr | Cost | Special |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Skeleton → Skeleton Warrior | 5→6 | 4→6 | 1–3 | 6 | 4→5 | 12 | 60→70 | — |
| 2 | Walking Dead → Zombie | 5 | 5 | 2–3 | 15→20 | 3→4 | 8 | 100→125 | Zombie: 20% disease (−2 enemy A/D, 3 rounds) |
| 3 | Wight → Wraith | 7 | 7 | 3–5 | 18 | 5→7 | 7 | 200→230 | regenerates to full HP (top creature) each round; Wraith: drains 2 enemy hero mana/round |
| 4 | Vampire → Vampire Lord | 10 | 9→10 | 5–8 | 30→40 | 6→9 | 4 | 360→500 | flying; no enemy retaliation; Lord: heals dealt damage, resurrecting own stack |
| 5 | Lich → Power Lich | 13 | 10 | 11–13→11–15 | 30→40 | 6→7 | 3 | 550→600 | ranged(12→24); death cloud: shot also hits hexes adjacent to target (living-only damage) |
| 6 | Black Knight → Dread Knight | 16→18 | 16→18 | 15–30 | 120 | 7→9 | 2 | 1200→1500 | wide; 20% curse on hit; Dread: 20% double damage |
| 7 | Bone Dragon → Ghost Dragon | 17→19 | 15→17 | 25–50 | 150→200 | 9→14 | 1 | 1800→3000+1merc | flying, wide; enemy army −1 morale; Ghost: 20% aging (target HP halved) |

### 4.4 Neutral creatures *(data — MVP minimal set for map guards)*

Add ~8 neutrals across power levels for map guards and dwellings: e.g. Peasant (1/1, 1 dmg, 1 HP, spd 3), Rogue, Wolf, Boar, Ogre, Troll, Cyclops-like "Gargantuan", and a couple of elementals. Stats analogous to tier equivalents above. *(data only, no code impact)*

## 5. Towns *(data: buildings.json + factions/*.json)*

A town has: owning player, faction, built structures, garrison (7 stacks) and a visiting hero slot, available-recruit pools per dwelling, and a mage guild spell list. **One build action per town per day.**

### 5.1 Common buildings (all factions)

| Building | Cost | Prereq | Effect |
|---|---|---|---|
| Village Hall | (built-in) | — | +500 gold/day |
| Town Hall | 2500g | Tavern | +1000 gold/day |
| City Hall | 5000g | Town Hall, Mage Guild 1, Marketplace, Blacksmith | +2000 gold/day |
| Capitol | 10000g, 10w, 10o | City Hall, Castle; only one per player | +4000 gold/day |
| Fort | 5000g, 20w, 20o | — | enables dwellings; siege: walls |
| Citadel | 2500g, 5o | Fort | growth +50%; siege: keep tower + moat |
| Castle | 5000g, 10w, 10o | Citadel | growth +100% (total ×2); siege: 2 extra towers |
| Tavern | 500g, 5w | — | hire heroes; +1 morale to garrison defenders |
| Marketplace | 500g, 5w | — | trade resources (rate 10:1 base, improves per extra marketplace owned: 10/7/5/4…:1) |
| Resource Silo | 5000g, 5o | Marketplace | +1 rare resource/day (faction-specific *(data)*) |
| Blacksmith | 1000g, 5w | — | sells war machines (post-MVP; build allowed, no effect) |
| Mage Guild 1–5 | 2000g+5w+5o; then +1000g+(5,5,7,10 each rare)/level | previous level; guild 4–5 may be faction-restricted | teaches spells (see §6) |

### 5.2 Dwellings

Each faction has 7 dwellings + 7 upgraded versions *(data)*: tier N dwelling requires Fort + tier N−1 dwelling (tree edges in data); upgrade requires base dwelling and often another building. Costs scale ~ (tier × 1000–2000 gold + resources). Buying the upgrade converts the pool; upgrading already-recruited creatures costs the price difference at the dwelling/town.

Recruitment: dwelling pool += growth weekly (×1.5 Citadel, ×2 Castle); recruit any amount ≤ pool into garrison/visiting hero for cost × count.

### 5.3 Faction special buildings *(data, MVP minimal)*

- Castle: **Stables** (visiting heroes +400 MP this week), **Brotherhood of the Sword** (tavern morale +2 instead of +1), Griffin Bastion (+3 Griffin growth).
- Rampart: **Fountain of Fortune** (defenders +2 luck), **Treasury** (+10% of player gold interest each week... simplify: +500g/day), Mystic Pond (random rare resource weekly).
- Necropolis: **Necromancy Amplifier** (all own heroes +10% Necromancy), **Skeleton Transformer** (visiting hero may convert any own stack into same-count Skeletons).

### 5.4 Town screen flow

Town screen shows: building grid with states (built / available / unaffordable / locked with reason), hall (build menu), garrison row + visiting hero row with drag-to-swap stacks (click-click on MVP), recruit dialogs with count slider + max button, mage guild viewer, tavern dialog. If town is captured by enemy hero, ownership flips (defender garrison fights first if present).

## 6. Magic *(data: spells.json)*

- Mana: hero pool = Knowledge × 10 (× Intelligence bonus). Regen +1/day (Mysticism more); **Magic Well** map object refills to max once/day.
- Spellbook acquired with hero (magic classes) or bought 500g at any own Mage Guild. Visiting a town with Mage Guild teaches the hero all guild spells of learnable level (Wisdom gates levels 3–5).
- Mage Guild levels hold 5/4/3/2/1 spells, rolled at build time from faction-allowed pool *(data)*.
- Each spell *(data)*: id, level 1–5, school (air/earth/fire/water), mana cost, target type (`enemyStack | friendlyStack | anyStack | area | battlefield | adventure`), base effect numbers per school-skill tier (none/basic/advanced/expert).
- A hero casts **max 1 combat spell per combat round** (army acts independently). Adventure spells cost movement: none for MVP except as noted.
- Damage spell formula: `damage = base + coef × SpellPower`; school skill raises `base` (values in table). Buff/debuff duration = SpellPower rounds.

### MVP spell list (24)

| Spell | Lv | School | Mana | Effect (none/basic → adv → expert) |
|---|---|---|---|---|
| Magic Arrow | 1 | all | 5 | dmg 10+10×SP → 20+10×SP → 30+10×SP |
| Haste | 1 | air | 6 | target +3 spd → +5 → all friendlies +5 |
| Slow | 1 | earth | 6 | target −25% spd → −50% → all enemies −50% |
| Shield | 1 | earth | 5 | melee dmg taken −15% → −30% → all friendlies −30% |
| Stone Skin | 1 | earth | 5 | +3 Def → +6 → all friendlies +6 |
| Bless | 1 | water | 5 | deals max dmg → max+1 → all friendlies |
| Curse | 1 | fire | 6 | deals min dmg → min(−20%) → all enemies |
| Bloodlust | 1 | fire | 5 | +3 Att (melee) → +6 → all friendlies |
| Cure | 1 | water | 6 | heal 10+5×SP top creature, remove debuffs → … → all friendlies |
| Dispel | 1 | water | 5 | remove buffs/debuffs from target → +enemy casts → whole battlefield |
| Lightning Bolt | 2 | air | 10 | dmg 10+25×SP → 20+25×SP → 50+25×SP |
| Ice Bolt | 2 | water | 8 | dmg 10+20×SP → 20+20×SP → 50+20×SP |
| Blind | 2 | fire | 10 | target can't act until damaged; retaliation at −50%→−75%→none |
| Weakness | 2 | water | 8 | target −3 Att → −6 → all enemies |
| Death Ripple | 2 | earth | 10 | dmg 5×SP+10 to ALL living stacks (both sides, undead immune) |
| Fireball | 3 | fire | 15 | dmg 15+10×SP → 30+10×SP → 60+10×SP, target hex + 6 adjacent |
| Animate Dead | 3 | earth | 15 | resurrect undead stack 30+50×SP HP → +base → permanent (always permanent in MVP) |
| Forgetfulness | 3 | water | 12 | enemy ranged stack can't shoot (half→full→all enemy shooters) |
| Chain Lightning | 4 | air | 24 | dmg 25+40×SP to target, jumps to 3→4→5 nearest stacks (any side), halving each jump |
| Meteor Shower | 4 | earth | 24 | dmg 25+25×SP → 50+25×SP → 100+25×SP, 3×3 hex area |
| Resurrection | 4 | earth | 20 | resurrect living stack 40+50×SP HP (permanent at expert; temporary = until combat end otherwise — MVP: always permanent, cost 160% if not expert? **simplify: permanent always**) |
| Town Portal | 4 | earth | 16 | adventure: teleport hero to nearest own town → chosen town (adv+) ; costs 300 MP, requires ≥300 MP |
| Implosion | 5 | earth | 30 | dmg 100+75×SP single target |
| Dimension Door | 5 | air | 25 | adventure: teleport hero to any visible passable tile in radius 8; max 2/day; costs 300 MP |

## 7. Combat

Triggered when a hero moves onto an enemy hero/town/garrison or a guarded object's trigger tile. Modal battle; the rest of the game pauses.

### 7.1 Battlefield

- Hex grid, **15 columns × 11 rows**, odd rows offset (axial coords; render as pointy-top offset hexes).
- Attacker stacks deploy in column 0 (rows spread top-to-bottom by slot order), defender in column 14, facing each other. Wide creatures occupy 2 horizontally-adjacent hexes.
- 0–8 impassable obstacle hexes generated from map terrain + seed (never blocking spawn columns ±1).

### 7.2 Turn order

- Combat proceeds in **rounds**. Each round every living stack gets one action, ordered by speed descending; ties: alternate attacker/defender, attacker first.
- **Wait** defers the stack to the end of the round (after-wait order: slowest first).
- Hero is not on the field; each hero may cast 1 spell per round at any moment during one of their own stacks' turns (MVP: at the start of any own stack's action).

### 7.3 Stack actions

- **Move**: up to `speed` hexes (BFS over unoccupied, non-obstacle hexes). Flying: ignores blockers in path, lands on free hex within speed.
- **Melee attack**: move adjacent + strike. Defender **retaliates** once per round (unless attacker has `no-retaliation`, or defender is blinded/bound/dead; Royal Griffin retaliates unlimited; Griffin twice).
- **Ranged attack** (if `ranged` and shots > 0 and no adjacent enemy): strike any visible stack; **distance penalty**: ×0.5 damage if target >10 hexes away; **melee penalty**: shooters forced to melee deal ×0.5 (unless `no melee penalty`). Adjacent enemy blocks shooting (must melee or move).
- **Defend**: +20% to effective Defense until next turn.
- **Wait**: as above, once per round.
- Special abilities (double shot/attack, breath, death cloud, jousting, bind, drain, etc.) per creature flags — implement as small composable hooks in combat engine.

### 7.4 Morale and luck

- Morale = base 0 + Leadership + artifacts + faction modifiers (all-same-faction army +1; undead in living army −1; Bone Dragon aura −1 enemy). Clamp −3..+3. Undead/mindless stacks: always 0.
- Positive morale: each stack action has `morale/24` chance of an immediate **extra action**. Negative: `|morale|/24` chance to **freeze** (lose action).
- Luck = Luck skill + artifacts + Fountain of Fortune, clamp −3..+3. Positive: `luck/24` chance of **double damage** on attack. (Negative luck: half damage — MVP: no negative luck sources, skip.)
- Roll morale/luck via game RNG; surface both in combat log + animation flag.

### 7.5 Damage formula (the heart of combat — implement exactly)

```
A = attacker stack creature Attack + attacking hero Attack (+ buffs/debuffs)
D = defender stack creature Defense + defending hero Defense (+ effects, +20% if defending)
base = Σ over creatures in stack of rand(dmgMin..dmgMax)   // cap: roll once × count if count>10
if A > D: mult = 1 + 0.05 × (A − D), capped at 4.0
if D > A: mult = 1 − 0.025 × (D − A), floored at 0.3
skills: ×(1+Offense) melee, ×(1+Archery) ranged; defender Armorer ×(1−armorer)
penalties: ×0.5 distance, ×0.5 melee-for-shooters, ×0.5 through-wall (siege)
luck: ×2 on lucky strike
specials: jousting ×(1+0.05×hexes), curse→min damage, bless→max damage
final = floor(product), minimum 1
```

Damage hits the stack HP pool: kills = pool reduction across creatures, top creature keeps remainder. Combat log line: "X Marksmen deal 47 damage; 3 Skeletons perish."

### 7.6 End of combat

- Side with no stacks loses. Loser hero is removed from map (army gone, artifacts → winner). Winner gains XP = Σ defeated creatures' AI value.
- **Flee** (own action, anytime, if not in siege defense): hero is dismissed to tavern pool, army lost, no artifacts lost? — MVP: flee = same as defeat but hero reappears in own tavern for rehire at 2500g.
- Necromancy: winner with skill raises skeletons (§3.4) added to army if slot available.
- Auto-combat button: AI plays the player's side (uses same combat AI as computer).

### 7.7 Sieges (simplified MVP rules)

Attacking a town **with Fort+**: battlefield gets a vertical wall in column 10 with 3 destructible wall segments (HP 2), a gate (drawbridge hex, opens for defender, melee-attackable), and with Citadel+ a **keep arrow tower** (shoots like a 10-Archer stack each round), Castle: +2 towers. Attacker gets an auto **catapult** (acts at round start: hits a random standing wall segment for 1, 50%; 2 with luck). Walls block ground movement until breached; flyers cross freely; shooters shoot over at ×0.5. Moat (Citadel+): hexes before wall stop movement and deal 70 dmg/turn standing. *(All numbers data-tunable.)*

## 8. Adventure map

### 8.1 Map model *(maps/format.md + zod schema)*

```jsonc
{
  "id": "tutorial-valley", "name": "Tutorial Valley", "size": 36,        // 36×36 tiles
  "players": [ {"color": "red", "faction": "castle", "isHuman": true,
                "startTownAt": [4,5], "startHero": "edric"}, … ],
  "tiles": "…",      // produced by ASCII DSL compiler, one terrain char per tile + road layer
  "objects": [ {"type": "mine", "subtype": "sawmill", "at": [10,12], "guard": {"creature": "wolf", "count": 20}},
               {"type": "resource", "subtype": "gold", "amount": 500, "at": [7,7]}, … ],
  "victory": {"type": "defeatAll"}, "loss": {"type": "loseAll"}
}
```

Authoring: an **ASCII map DSL** — terrain layer as a char grid (`g`rass, `d`irt, `s`and, `n`snow, `w`ater, `r`ough, `S`wamp, `l`ava), road layer, plus an object list. A compiler turns DSL → map JSON; sample maps are written in DSL and compiled at build time. This makes maps diffable, hand-editable, and easy to write in tests.

### 8.2 Tiles and interaction model

- Each tile: terrain, optional road, optional object reference, passability (object footprints block; each object has a **trigger tile** — usually its bottom-center — stepping on it interacts).
- Objects are either **visitable** (repeatable: well, stable) or **removable** (resource piles, chests, artifacts) or **flaggable** (mines, dwellings) or **enterable** (towns).
- Guards: an object may have a creature stack; interacting first offers a fight (show estimated strength: "Pack of Wolves — would you like to attack?"). Guard stacks grow +10%/week.

### 8.3 Map object catalog (MVP — 20 types)

| Object | Behavior |
|---|---|
| Town | enter: town screen; enemy: siege/fight then capture |
| Mine ×7 | flag for daily income; may be guarded |
| Resource pile | pick up amount (wood/ore 5–10, rare 3–6, gold 500–1000, rolled by seed) |
| Treasure chest | choose: gold (1000/1500/2000) or XP (500/1000/1500), rolled tiers |
| Artifact | pick up (fight guard if any) |
| Monster | wandering guard stack; blocks a chokepoint; fight (or it may join for gold if much weaker — MVP: always fights) |
| External dwelling | flag; recruit creatures weekly (tier 1–4 neutrals/faction units) |
| Windmill | weekly: 3–6 of a random rare resource |
| Water Wheel | weekly: 500 gold (1000 first week) |
| Mystical Garden | weekly: 500 gold or 5 gems |
| Magic Well | refill hero mana, 1×/day |
| Fountain of Fortune | +1..3 luck until next battle |
| Rally Flag | +1 morale & luck until next battle |
| Learning Stone | +1000 XP, once per hero |
| School of War | pay 1000g: +1 Attack or Defense, once per hero |
| Redwood Observatory | reveal 20-tile radius |
| Sign | shows message text |
| Monolith (2-way) | teleport between paired monoliths |
| Prison | frees a stored hero, joins your side |
| Obelisk | (post-MVP Grail stub: shows "?") |

### 8.4 Fog of war

Two layers per player: **shroud** (never seen — black) and **explored** (seen before — dimmed, shows terrain+static objects at last-seen state, hides moving heroes). Sight radius: 5 + Scouting + artifacts, revealed circularly around heroes/towns each move. AI respects the same visibility for fairness (MVP: AI may cheat-see — acceptable, note it).

## 9. AI opponent (MVP heuristic)

Runs the same Command API. Per AI turn, per hero, loop until MP exhausted:
1. Score visible opportunities: `value / distance` where value: enemy town 200, weak enemy hero 150 (army power < 0.8× own), mine 60 (unowned), artifact/chest/resource 40, dwelling 30, neutral-guarded anything: value × powerRatio gate (fight only if own power ≥ 1.3× guard).
2. Army power = Σ count × AI value. Move toward best target; fight with the combat AI.
3. Towns: build priority list: City Hall track → Castle track → highest-tier affordable dwelling → mage guild. Recruit everything affordable each week to main hero.
4. Combat AI (also used for auto-combat): per stack — shooters shoot biggest-threat (highest damage potential) target; melee: attack reachable target with best `damage dealt − retaliation taken`; else move toward nearest enemy; cast hero's best damage spell at biggest stack if mana ≥ cost.

## 10. UI screens and design

Layout container 1280×800 logical px, scales to window (letterbox). Faction color palette: Castle #2b6cb0, Rampart #2f855a, Necropolis #4a5568; player colors red/blue/tan/green. Dark UI theme, parchment-style panels for dialogs.

1. **Main menu**: New Game (map select, players/factions/difficulty config), Load Game, (Settings stub).
2. **Adventure screen**: center canvas viewport (scroll: edge/arrow/drag, zoom optional); right sidebar: minimap (player-colored ownership dots, viewport rect, click-to-jump), day/week/month indicator, hero list (portraits + MP bars) and town list (switchable), selected-hero panel (army preview, MP/mana numbers), buttons: Next Hero, End Turn, Spellbook, System. Bottom bar: 7 resource counters + date. Hero path preview drawn on canvas with day-break markers. Right-click anywhere: info popup of the hovered entity.
3. **Town screen**: DOM overlay (see §5.4).
4. **Hero screen**: stats block, XP/level + progress, skill grid (16 slots), 7 army slots (click-click to move/split — split dialog with slider), artifact paper-doll (head/neck/torso/weapon/shield/feet/ring×2/misc×4) + backpack list, dismiss hero button. Two-hero exchange screen when heroes meet: both armies/artifacts side by side.
5. **Combat screen**: canvas hex field; stacks as faction-colored tokens (initials + tier), count badge bottom-right, active-stack highlight, reachable-hex shading, hover: damage estimate tooltip ("kills 2–4"); bottom bar: Wait / Defend / Auto / Flee / Spellbook + combat log (scrollback 50); hero portraits + casts left/mana on sides. Animations: simple tween of token position + floating damage numbers (200ms, skippable).
6. **Dialogs**: modal queue system (level-up choice, chest choice, combat result, week banner, message signs). All dialogs keyboard-confirmable (Enter/Esc).

Placeholder art: `render/tokens.ts` draws every creature as disc + initials + tier pip, heroes as shield shape, towns as castle silhouette in faction color, terrain as flat color + 5% noise, obstacles as gray polygons. All drawing behind `Painter` interface for future asset swap.

## 11. Save / load

`serializeGame(state) → JSON` (already pure data) + version field; localStorage slots (5) + export/import file. Loading validates with zod and migrates by version. Mid-combat saves: store combat sub-state too.

---

# Technical Details

- **Language/tooling**: TypeScript 5 strict, Vite, Vitest (+ @vitest/coverage-v8), Playwright, ESLint flat config + typescript-eslint, Prettier. No UI framework; no runtime deps beyond `zod`.
- **State shape** (sketch):

```ts
interface GameState {
  seed: number; rngState: number;
  day: number;                      // 1-based; week = ceil(day/7), month = ceil(day/28)
  players: Player[]; currentPlayer: PlayerId;
  map: MapState;                    // tiles, objects (with per-object mutable state)
  heroes: Record<HeroId, Hero>; towns: Record<TownId, Town>;
  combat: CombatState | null;       // non-null while a battle is in progress
  pendingChoices: Choice[];         // level-up picks, chest choices … block other commands
  status: 'running' | { winner: PlayerId };
}
type Command = { type: 'moveHero', hero: HeroId, path: Pos[] } | { type: 'endTurn' }
  | { type: 'build', town: TownId, building: string } | { type: 'recruit', … }
  | { type: 'combatAction', action: CombatAction } | { type: 'castAdventureSpell', … }
  | { type: 'resolveChoice', choiceId: string, option: number } | …;
dispatch(state, cmd): { state: GameState; events: GameEvent[] }   // events drive UI/log/animations
```

- **RNG**: mulberry32; `rngState` advances inside state ⇒ replayable. Helper `rollRange(state, min, max)`.
- **Determinism rule**: core never reads clock, never calls Math.random, never mutates input state outside the dispatcher (use structural copy or immer-style manual copies — no library; document the convention).
- **Rendering loop**: requestAnimationFrame redraws dirty layers; core emits `GameEvent[]` consumed by an animation queue; UI blocks input while `pendingChoices` non-empty or animations critical.
- **Data validation**: every JSON file has a zod schema; `npm run validate-data` (and a unit test) fails on dangling ids (creature referenced by dwelling that doesn't exist, spell in guild pool that doesn't exist, building prereq cycles).

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): all code, data, maps, tests, docs in this repo.
- **Post-Completion** (no checkboxes): manual playtesting, balance tuning, deployment, post-MVP stretch list.

# Implementation Steps

### Task 1: Project scaffolding and toolchain

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `index.html`, `src/app/main.ts`, `playwright.config.ts`, `.gitignore`, `README.md`
- Create: `src/core/rng.ts`, `src/core/rng.test.ts`

- [x] `git init`; scaffold Vite + TS strict project; add zod, vitest, coverage, playwright, eslint, prettier; scripts: `dev`, `build`, `test`, `test:e2e`, `check` (tsc+eslint+vitest)
- [x] `index.html` + `main.ts` render a "Heroes Clone" placeholder div (e2e smoke target)
- [x] implement `rng.ts`: mulberry32, `rollRange`, `rollChance`, state in/out (no globals)
- [x] write tests for rng: determinism (same seed = same sequence), range bounds, distribution sanity, state round-trip
- [x] write Playwright smoke test: page loads, title visible
- [x] run `npm run check` and `npm run test:e2e` — must pass before task 2

### Task 2: Game data files, schemas, and loader

**Files:**
- Create: `src/data/schema.ts` (zod schemas for all content types)
- Create: `src/data/creatures.json`, `src/data/skills.json`, `src/data/spells.json`, `src/data/artifacts.json`, `src/data/buildings.json`, `src/data/terrain.json`, `src/data/heroes.json`, `src/data/objects.json`, `src/data/factions/{castle,rampart,necropolis}.json`
- Create: `src/data/index.ts` (loader, cross-reference validation), `src/data/data.test.ts`

- [x] define zod schemas for creature, skill, spell, artifact, building, terrain, hero template, faction, map object type (fields per spec §2–§8)
- [x] author all JSON content from the spec tables: 42 faction creatures (§4.1–4.3) + 8 neutrals, 16 skills, 24 spells, ~20 artifacts (simple stat/skill bonuses across 4 rarity classes), common+faction buildings with prereq edges, 6 hero classes + 4 named heroes each, terrain costs, 20 object types
- [x] implement loader: parse all files, build typed `GameData` registry, validate cross-references (dangling ids, prereq cycles)
- [x] write tests: every file parses against schema; cross-reference check catches a deliberately broken fixture; spot-check loaded values (e.g. Archangel cost, Slow is earth L1)
- [x] run tests — must pass before task 3

### Task 3: Map format, ASCII DSL compiler, and sample maps

**Files:**
- Create: `src/maps/schema.ts`, `src/maps/dsl.ts` (compiler), `src/maps/dsl.test.ts`
- Create: `src/maps/tutorial-valley.dsl.ts` (36×36, 2 players), `src/maps/contested-river.dsl.ts` (48×48, 3 players), `src/maps/fixtures/tiny.dsl.ts` (12×12 test map)
- Create: `src/maps/index.ts` (map registry), `src/maps/maps.test.ts`

- [x] define map JSON zod schema (§8.1): size, players, tiles (terrain+road), objects with guards/amounts, victory/loss
- [x] implement DSL compiler: char-grid terrain layer + road layer + object list → validated map JSON; helpful errors with row/col
- [x] author 3 maps: tiny test fixture (hero, town, 1 mine, 1 guard, resources), tutorial 2-player, 3-player map with chokepoint guards and monolith pair
- [x] write tests: compiler errors (bad char, ragged grid, object out of bounds, overlapping footprints); compiled maps validate; tiny map snapshot
- [x] run tests — must pass before task 4

### Task 4: GameState core, command dispatcher, turn cycle

**Files:**
- Create: `src/core/state.ts`, `src/core/commands.ts`, `src/core/turn.ts`, `src/core/setup.ts` (new game from map), `src/core/serialize.ts`
- Create: `src/core/turn.test.ts`, `src/core/setup.test.ts`, `src/core/serialize.test.ts`

- [x] implement `GameState` types + `newGame(map, config, seed)`: places towns/heroes, starting resources/army, initial fog
- [x] implement command dispatcher skeleton with event emission; reject commands from non-current player or while `pendingChoices` pending
- [x] implement `endTurn`: advance player; on full rotation advance day — income (hall + owned mines), MP/mana regen, weekly growth + week banner event, monthly event hook
- [x] implement serialize/deserialize with version field
- [x] write tests: new-game setup from tiny fixture (positions, resources, pools); income math day 1 vs after capturing a mine; weekly growth (×1.5/×2 with citadel/castle); serialization round-trip equality; command rejection cases
- [x] run tests — must pass before task 5

### Task 5: Movement and pathfinding

**Files:**
- Create: `src/core/movement.ts`, `src/core/movement.test.ts`
- Modify: `src/core/commands.ts`, `src/core/hero.ts` (create — MP calc)

- [x] implement terrain cost lookup (+roads, +diagonal ×1.414, Pathfinding skill reduction §3.5) and daily MP formula (slowest creature + Logistics)
- [x] implement A* pathfinding over passable tiles (objects' footprints block; trigger tiles enterable)
- [x] implement `moveHero` command: validated step-by-step consumption of MP along path, stopping at triggers, emitting move events
- [x] write tests: A* optimality vs brute force on small grids; road preference; impassables; MP exhaustion mid-path; diagonal cost; Logistics/Pathfinding effects; cannot move through another hero
- [x] run tests — must pass before task 6

### Task 6: Hero progression — XP, level-ups, skills, army management

**Files:**
- Modify: `src/core/hero.ts`
- Create: `src/core/hero.test.ts`

- [x] implement XP gain + level threshold table; level-up: class-weighted primary stat roll + two-skill offer as `pendingChoices` entry (§3.3); `resolveChoice` applies pick
- [x] implement army ops: merge/split/swap stacks between slots and between two heroes / hero↔garrison; 7-slot limit; cannot leave hero with empty army
- [x] implement artifact equip/unequip with slot validation + stat/skill aggregation helper `effectiveStats(hero)`
- [x] write tests: threshold boundaries; multi-level single XP gain queues multiple choices; stat roll uses seeded rng (golden values); 8-skill cap offers upgrades only; army split/merge invariants (total count conserved); artifact slot rules and stat aggregation
- [x] run tests — must pass before task 7

### Task 7: Adventure map object interactions

**Files:**
- Create: `src/core/objects.ts`, `src/core/objects.test.ts`
- Modify: `src/core/movement.ts` (trigger dispatch)

- [x] implement all 20 object behaviors from §8.3 (combat-triggering ones enqueue a combat start, resolved in Task 8–9; mark with TODO until combat lands)
- [x] implement flagging (mines/dwellings), weekly visitables reset, once-per-hero tracking (learning stone), pickup removal, monolith teleport, prison hero release
- [x] implement guard handling: power estimate text, attack-confirm `pendingChoice`, +10%/week guard growth
- [x] write tests: each object type's state change (resource added, mine flagged, chest choice branches, well once/day reset, monolith pairing, prison joins) — table-driven over fixture map
- [x] run tests — must pass before task 8 (combat-gated paths: guard fights / sieges queue a `pendingCombat` placeholder with TODO(Task 8/9) markers in `objects.ts`; tests assert the queued combat)
- [x] run tests - must pass before next task

### Task 8: Combat engine — battlefield, turn order, melee/ranged, damage

**Files:**
- Create: `src/core/combat/state.ts`, `src/core/combat/grid.ts` (hex math), `src/core/combat/engine.ts`, `src/core/combat/damage.ts`
- Create: `src/core/combat/grid.test.ts`, `src/core/combat/damage.test.ts`, `src/core/combat/engine.test.ts`

- [x] implement hex grid (15×11 axial), neighbors, distance, BFS reachability, wide-creature occupancy, obstacle generation from seed
- [x] implement combat setup from two armies (+hero stats), initiative queue (speed desc, alternate ties, wait re-queue §7.2)
- [x] implement actions: move, melee (+retaliation rules), ranged (+distance/melee penalties, shots), defend, wait; stack HP-pool damage application and death
- [x] implement damage formula exactly per §7.5 as pure `computeDamage(attacker, defender, ctx)` returning breakdown (for tooltips/log)
- [x] write tests: hex math properties (distance symmetry, neighbor counts incl. edges); golden damage cases (A>D cap 4.0, D>A floor 0.3, min 1, luck double, jousting, penalties stacking); retaliation once/unlimited/none; wait ordering; wide-creature blocking; full scripted 2-stack battle replay snapshot
- [x] run tests — must pass before task 9

### Task 9: Combat completion — specials, morale/luck, spells in combat, end conditions, sieges

**Files:**
- Modify: `src/core/combat/engine.ts`
- Create: `src/core/combat/abilities.ts`, `src/core/combat/siege.ts`, `src/core/magic.ts`
- Create: `src/core/combat/abilities.test.ts`, `src/core/combat/siege.test.ts`, `src/core/magic.test.ts`

- [x] implement ability hooks: double shot/attack, no-retaliation, life drain, regeneration, bind, blind/curse/disease/aging on-hit chances, breath, death cloud, mana drain, magic resistance, spell-level immunity, Archangel resurrect+morale aura, Bone Dragon morale debuff
- [x] implement morale/luck rolls per §7.4 with events
- [x] implement magic system: mana, spellbook learning (guild visit, Wisdom gate), combat casting 1/round, all 22 combat spells (effects per §6 table, school-tier scaling, undead/mind immunities), buff/debuff duration tracking
- [x] implement combat end: victory/defeat/flee, XP award, artifact transfer, Necromancy skeleton raise, town capture on siege win; connect Task 7 combat-gated object paths and remove their TODOs
- [x] implement simplified siege per §7.7 (walls, gate, catapult, towers, moat)
- [x] write tests: each ability in isolation (table-driven); morale/luck statistics over seeds (≈n/24 within tolerance); every spell's effect + immunity matrix (undead vs Bless/Blind/Death Ripple, dragon spell-level immunity, dwarf resistance roll); animate/resurrection HP math; necromancy yield; full siege battle replay snapshot; flee/rehire flow
- [x] run tests — must pass before task 10
- ➕ note: game-level combat glue lives in `src/core/combat/resolve.ts` (start guard/siege combat, finish combat, flee, necromancy, tavern pool); defeated/fled hero templates collect in `GameState.tavernPool` for the Task 10 tavern rehire flow

### Task 10: Town system — building, recruiting, mage guild, marketplace

**Files:**
- Create: `src/core/town.ts`, `src/core/town.test.ts`
- Modify: `src/core/commands.ts`

- [x] implement build command: prereq/cost/once-per-day validation, effects (income, growth multipliers, guild spell roll from faction pool via rng, special buildings §5.3)
- [x] implement recruit command (pool/cost/slot checks, garrison or visiting hero), creature upgrade-for-difference, external dwellings reuse same code
- [x] implement marketplace trade rates (10/7/5/4:1 by marketplace count) + trade command; Skeleton Transformer; tavern hero pool + hire command (2500g, weekly refresh, 8-hero cap)
- [x] implement town capture (garrison defense battle first if non-empty)
- [x] write tests: build tree validation (each prereq edge, one-per-day, capitol uniqueness), income deltas, guild rolls deterministic per seed and never duplicate spells, recruit/upgrade math, trade rates, hire flow and cap, capture with/without garrison
- [x] run tests — must pass before task 11
- ➕ note: halls replace each other on build (income is absolute per spec table, not additive); stables bonus simplified to dawn-while-visiting + on-build; per-town tavern offers live in `Town.tavernHeroes` (save version bumped to 3); special-building effects: treasury income (data), mystic pond weekly rare, griffin bastion `growthBonus` (new data field), tavern/brotherhood siege defender morale, fountain of fortune defender luck, necromancy amplifier +10%/town

### Task 11: Fog of war and victory conditions

**Files:**
- Create: `src/core/fog.ts`, `src/core/victory.ts`
- Create: `src/core/fog.test.ts`, `src/core/victory.test.ts`

- [x] implement per-player shroud/explored bitmasks, circular reveal (radius 5 + Scouting + artifacts) on move/capture, Observatory reveal, last-seen object state for dimmed layer
- [x] implement victory/loss evaluation each command: defeatAll win, loseAll loss, 7-day townless countdown; emit game-over event; block further commands
- [x] implement adventure spells now that map+fog exist: Town Portal, Dimension Door (visibility + MP rules §6)
- [x] write tests: reveal radii incl. map edges; explored persists, shroud doesn't; townless countdown resets on capture; defeatAll exact trigger; TP nearest-vs-chosen by skill; DD into shroud rejected, 2/day cap
- [x] run tests — must pass before task 12
- ➕ note: fog helpers (`revealCircle`/`isExplored`/`sightRadius`) moved from `state.ts` into `fog.ts`; `revealFor` also snapshots objects into `Player.seenObjects` (dimmed-layer state), `visibleTiles` computes the bright layer for the renderer; `Hero.dimensionDoorCasts` + `Player.seenObjects` bumped save version to 4; `newGame` now registers all map-authored owned towns in `player.towns` (needed for TP/loseAll); when the current player eliminates themselves the turn passes to the next active player (day advances on wrap)

### Task 12: Golden replay harness + full-game core test

**Files:**
- Create: `src/core/replay.ts` (run command script → state), `src/core/replay.test.ts`
- Create: `src/core/fixtures/full-game.replay.ts`

- [ ] implement replay runner: `runScript(map, seed, Command[]) → {state, events}` + state hash helper
- [ ] script a complete miniature game on the tiny fixture: move, pick up, capture mine, build, recruit, fight a guard, level up, capture enemy town, win — assert key state at checkpoints + final hash
- [ ] write determinism test: same script twice ⇒ identical hash; different seed ⇒ different rng outcomes but valid end state
- [ ] add invariant sweep test: after every command in the script — resource ≥ 0, stack counts > 0, MP ≥ 0, state serializes and round-trips
- [ ] run tests — must pass before task 13

### Task 13: Adventure screen rendering and input

**Files:**
- Create: `src/render/painter.ts` (token art system §10), `src/render/adventureRenderer.ts`, `src/render/camera.ts`
- Create: `src/ui/hud.ts` (sidebar, resource bar, minimap), `src/app/screens.ts` (router), `src/app/adventureScreen.ts`
- Create: `e2e/adventure.spec.ts`

- [ ] implement Painter token art (creature disc/initials/tier, hero shield, town silhouette, terrain colors, fog layers) behind interface
- [ ] implement canvas adventure renderer: visible-rect tile draw, objects, heroes, selection ring, path preview with day markers, dirty-flag rAF loop; camera scroll (keys/edge/drag) and tile hit-testing
- [ ] implement HUD: resource bar, day indicator, minimap (ownership colors, viewport rect, click-jump), hero/town lists, next-hero/end-turn buttons, right-click info popups; wire commands→dispatch→event-driven redraw
- [ ] write unit tests for camera math (world↔screen, clamping) and path-preview day-split logic (pure helpers)
- [ ] write e2e: load tutorial map, select hero, click destination twice → hero token moved, resource bar increases after end-turn, minimap click jumps viewport
- [ ] run tests + e2e — must pass before task 14

### Task 14: Town, hero, and dialog UI

**Files:**
- Create: `src/ui/townScreen.ts`, `src/ui/heroScreen.ts`, `src/ui/dialogs.ts` (modal queue), `src/ui/recruitDialog.ts`, `src/ui/components.ts`
- Create: `e2e/town-hero.spec.ts`

- [ ] implement modal dialog queue bound to `pendingChoices` + informational events (week banner, sign, chest choice, level-up two-option picker, combat result)
- [ ] implement town screen per §5.4: building grid with lock reasons, hall build menu, recruit dialog (slider+max), garrison/visiting rows with click-click swap, guild viewer, tavern hire, marketplace trade UI
- [ ] implement hero screen + two-hero exchange: stats, skills, army with split dialog, artifact paper-doll + backpack
- [ ] write unit tests for pure UI helpers (build-availability reasons, recruit max calc, trade rate calc rendering model)
- [ ] write e2e: open town → build Town Hall → next day income reflects; recruit max pikemen → garrison badge updates; hero screen split stack; level-up dialog appears after Learning Stone ×2 and choice persists
- [ ] run tests + e2e — must pass before task 15

### Task 15: Combat screen UI

**Files:**
- Create: `src/render/combatRenderer.ts`, `src/ui/combatScreen.ts`, `src/ui/spellbook.ts`
- Create: `e2e/combat.spec.ts`

- [ ] implement hex battlefield renderer: hexes, obstacles, walls (siege), stack tokens + count badges, active highlight, reachable shading, hover damage-estimate tooltip (uses `computeDamage` breakdown), floating damage numbers + 200ms move tweens (skippable)
- [ ] implement combat controls: hex click-to-move/attack with direction picking for melee (attack from clicked adjacent hex), Wait/Defend/Auto/Flee buttons, combat log panel, spellbook overlay (filter by school/level, mana costs, castable targeting)
- [ ] wire auto-combat to combat AI placeholder (random-legal-move until Task 16, then real AI)
- [ ] write unit tests for renderer-side pure helpers: hex pixel↔axial conversion, reachable-set memo, tooltip damage-range text
- [ ] write e2e: trigger guard fight on tutorial map, win a scripted easy battle via attacks, see result dialog and XP; cast Magic Arrow from spellbook; defend/wait buttons advance queue
- [ ] run tests + e2e — must pass before task 16

### Task 16: AI players

**Files:**
- Create: `src/core/ai/adventureAI.ts`, `src/core/ai/combatAI.ts`, `src/core/ai/economyAI.ts`
- Create: `src/core/ai/ai.test.ts`

- [ ] implement combat AI per §9.4 (shooter targeting, melee value trade, approach, spell pick) — pure function `chooseCombatAction(combatState) → CombatAction`
- [ ] implement economy AI (build priority list, weekly recruit-all to main hero) and adventure AI (opportunity scoring loop §9.1–9.3, power-ratio gate 1.3)
- [ ] wire AI turns into endTurn flow with per-command event stream (UI shows "Enemy turn…" + optionally visible moves in explored area); replace auto-combat placeholder
- ➕ allow `moveHero` onto an enemy hero's tile to trigger hero-vs-hero field combat (movement currently blocks all hero tiles; the combat itself reuses the Task 9 resolve flow)
- [ ] write tests: combat AI never returns illegal action (fuzz over 200 seeded random combat states); AI beats an idle player on tiny map within 4 weeks (integration, seeded); economy AI builds capitol track in valid order; full AI-vs-AI game on tiny map terminates < 3 months with a winner (no hangs)
- [ ] run tests — must pass before task 17

### Task 17: Game shell — main menu, new game config, save/load

**Files:**
- Create: `src/app/mainMenu.ts`, `src/app/newGameSetup.ts`, `src/app/saveload.ts`
- Modify: `src/app/main.ts`, `src/app/screens.ts`
- Create: `e2e/shell.spec.ts`, `src/app/saveload.test.ts`

- [ ] implement main menu + new-game setup (map list with player counts, faction/color/difficulty pick, hotseat toggle making 2 humans alternate with a "pass device" screen)
- [ ] implement save/load: 5 localStorage slots + export/import JSON file, version check + migration hook, mid-combat save support, autosave each day
- [ ] implement game-over flow (victory/defeat screen → menu)
- [ ] write unit tests: save/load round-trip mid-combat; version mismatch rejected gracefully; autosave rotation
- [ ] write e2e: full happy path — menu → new game on tiny map → play 2 days → save → reload page → load → state intact (day counter, hero position); hotseat pass screen appears
- [ ] run tests + e2e — must pass before task 18

### Task 18: Balance pass, difficulty, and polish

**Files:**
- Modify: `src/data/*.json`, `src/core/setup.ts`, `src/ui/*`
- Create: `src/core/balance.test.ts`

- [ ] implement difficulty settings (easy/normal/hard: starting resources 30k/20k/10k & AI gets ±20% resource handicap)
- [ ] add keyboard shortcuts (E end turn, H next hero, Space defend/visit again, arrows scroll), Esc closes dialogs, Enter confirms
- [ ] sanity-balance via simulation: AI-vs-AI on both real maps × 10 seeds — assert games end, no faction wins > 80% of mirrorless matches (crude balance signal), log table of win rates
- [ ] write tests: difficulty modifiers applied; shortcut→command mapping unit test; the simulation suite above as a slow tagged test (`npm run test:balance`)
- [ ] run full check — must pass before task 19

### Task 19: Verify acceptance criteria

- [ ] verify all requirements from Overview are implemented: explore/collect/capture, town building, recruiting, hex combat with spells+sieges, 3 factions, AI opponents, fog, save/load, win/loss, hotseat
- [ ] verify edge cases: 7-slot army limits, 8-skill cap, mana floors, last-town loss countdown, simultaneous-day mine income, mid-combat save
- [ ] run full test suite: `npm run check`
- [ ] run e2e tests: `npm run test:e2e`
- [ ] verify coverage ≥80% on `src/core/` (`npm test -- --coverage`)

### Task 20: [Final] Update documentation

- [ ] write README.md: how to run/build/test, architecture overview, how to add a faction (data-only walkthrough), map DSL guide
- [ ] create CLAUDE.md with project conventions (determinism rule, command pattern, data-driven content, test commands)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Manual verification:**
- Play a full game on each map at each difficulty; confirm fun/pacing (first battle within day 2–3, first tier-7 by week 4–6)
- Verify performance: 60fps scroll on a 48×48 map, combat with 14 stacks; profile if not
- Cross-browser sanity: Chrome, Firefox, Safari

**Post-MVP stretch list (in rough priority order):**
- Remaining 6 factions (Tower, Inferno, Dungeon, Stronghold, Fortress, Conflux) — data + a few new ability hooks
- Underground level + subterranean gates; boats and water terrain; war machines (ballista, first aid tent, ammo cart)
- Grail/obelisk puzzle map; random map generator; map editor UI; campaign sequences
- Remaining spells/artifacts to full set; creature banks; diplomacy (joining monsters)
- Real art/sound asset pipeline behind the Painter interface; network multiplayer on top of the command stream

**External system updates:**
- Deployment (static hosting — Vite build output) — user deploys, do not deploy from here
