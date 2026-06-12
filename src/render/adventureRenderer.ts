import type { GameData } from '../data';
import type { Road, Terrain } from '../data/schema';
import { NO_ROAD_CHAR, type Pos } from '../maps/schema';
import type { GameState, Player, SeenObject } from '../core/state';
import {
  TILE_PX,
  tileScreenRect,
  visibleTileRange,
  worldSizePx,
  type Camera,
} from './camera';
import { initialsOf, NEUTRAL_COLOR, PLAYER_COLOR_HEX, type Painter } from './painter';
import type { PathStepPreview } from './pathPreview';

export interface AdventureView {
  state: GameState;
  player: Player; // whose fog of war we render
  visible: boolean[]; // bright-layer mask (fog.visibleTiles)
  camera: Camera;
  selectedHero: string | null;
  pathPreview: readonly PathStepPreview[] | null;
}

interface DrawableObject {
  type: string;
  at: Pos;
  owner: Player['id'] | null;
  subtype?: string;
  creature?: string;
}

export class AdventureRenderer {
  private readonly terrainByChar = new Map<string, Terrain>();
  private readonly roadByChar = new Map<string, Road>();

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly painter: Painter,
    private readonly data: GameData,
  ) {
    for (const t of Object.values(data.terrains)) this.terrainByChar.set(t.char, t);
    for (const r of Object.values(data.roads)) this.roadByChar.set(r.char, r);
  }

  render(view: AdventureView): void {
    const { ctx } = this;
    const { state, camera } = view;
    const size = state.map.size;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, camera.width, camera.height);

    const range = visibleTileRange(camera, size);
    this.drawTerrain(view, range.x0, range.y0, range.x1, range.y1);
    this.drawObjects(view);
    this.drawDimOverlay(view, range.x0, range.y0, range.x1, range.y1);
    this.drawHeroes(view);
    this.drawPathPreview(view);
  }

  private isExplored(view: AdventureView, x: number, y: number): boolean {
    return view.player.explored[y * view.state.map.size + x] ?? false;
  }

  private isVisible(view: AdventureView, x: number, y: number): boolean {
    return view.visible[y * view.state.map.size + x] ?? false;
  }

  private drawTerrain(view: AdventureView, x0: number, y0: number, x1: number, y1: number): void {
    const { state, camera } = view;
    const size = state.map.size;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const rect = tileScreenRect(camera, [x, y]);
        if (!this.isExplored(view, x, y)) {
          this.painter.shroud(this.ctx, rect.x, rect.y, rect.size);
          continue;
        }
        const i = y * size + x;
        const terrain = this.terrainByChar.get(state.map.terrain[i] ?? '');
        this.painter.terrain(this.ctx, rect.x, rect.y, rect.size, terrain?.color ?? '#000000');
        const roadChar = state.map.roads[i] ?? NO_ROAD_CHAR;
        if (roadChar !== NO_ROAD_CHAR) {
          this.painter.road(this.ctx, rect.x, rect.y, rect.size);
        }
      }
    }
  }

  private drawObjects(view: AdventureView): void {
    const drawn = new Set<string>();
    for (const obj of view.state.map.objects) {
      const [x, y] = obj.at;
      if (!this.isVisible(view, x, y)) continue;
      drawn.add(obj.id);
      if (obj.removed) continue;
      this.drawObject(view, obj);
    }
    // explored-but-not-visible: last-seen snapshots
    for (const [id, seen] of Object.entries(view.player.seenObjects)) {
      if (drawn.has(id) || seen.removed) continue;
      const [x, y] = seen.at;
      if (!this.isExplored(view, x, y)) continue;
      this.drawObject(view, seen);
    }
  }

  private drawObject(view: AdventureView, obj: DrawableObject | SeenObject): void {
    const rect = tileScreenRect(view.camera, obj.at);
    const cx = rect.x + rect.size / 2;
    const cy = rect.y + rect.size / 2;
    const ownerColor = obj.owner !== null ? PLAYER_COLOR_HEX[obj.owner] : NEUTRAL_COLOR;

    if (obj.type === 'town') {
      this.painter.townToken(this.ctx, cx, cy, rect.size * 0.42, ownerColor);
      return;
    }
    if (obj.type === 'monster' && 'creature' in obj) {
      const creature = this.data.creatures[obj.creature];
      this.painter.creatureToken(
        this.ctx,
        cx,
        cy,
        rect.size * 0.38,
        NEUTRAL_COLOR,
        initialsOf(creature?.name ?? obj.creature),
        creature?.tier ?? 1,
      );
      return;
    }
    this.painter.objectToken(
      this.ctx,
      cx,
      cy,
      rect.size * 0.4,
      this.objectColor(obj.type),
      this.objectLabel(obj),
    );
    if (obj.type === 'mine' || obj.type === 'dwelling') {
      this.painter.flag(this.ctx, rect.x, rect.y, rect.size, ownerColor);
    }
  }

  private objectColor(type: string): string {
    switch (type) {
      case 'mine':
        return '#744210';
      case 'resource':
      case 'treasure_chest':
        return '#975a16';
      case 'artifact':
        return '#6b46c1';
      case 'dwelling':
        return '#2c5282';
      default:
        return '#4a5568';
    }
  }

  private objectLabel(obj: DrawableObject | SeenObject): string {
    if (obj.subtype !== undefined) {
      if (obj.type === 'mine') {
        const sub = this.data.objectTypes.mine?.subtypes?.find((s) => s.id === obj.subtype);
        return initialsOf(sub?.name ?? obj.subtype);
      }
      return initialsOf(obj.subtype);
    }
    const objectType = this.data.objectTypes[obj.type];
    return initialsOf(objectType?.name ?? obj.type);
  }

  private drawDimOverlay(
    view: AdventureView,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!this.isExplored(view, x, y) || this.isVisible(view, x, y)) continue;
        const rect = tileScreenRect(view.camera, [x, y]);
        this.painter.dimmed(this.ctx, rect.x, rect.y, rect.size);
      }
    }
  }

  private drawHeroes(view: AdventureView): void {
    for (const hero of Object.values(view.state.heroes)) {
      const [x, y] = hero.pos;
      if (!this.isVisible(view, x, y)) continue;
      const rect = tileScreenRect(view.camera, hero.pos);
      const cx = rect.x + rect.size / 2;
      const cy = rect.y + rect.size / 2;
      if (hero.id === view.selectedHero) {
        this.painter.selectionRing(this.ctx, cx, cy, rect.size * 0.48);
      }
      this.painter.heroToken(
        this.ctx,
        cx,
        cy,
        rect.size * 0.36,
        PLAYER_COLOR_HEX[hero.owner],
        initialsOf(hero.name, 1),
      );
    }
  }

  private drawPathPreview(view: AdventureView): void {
    if (!view.pathPreview) return;
    const last = view.pathPreview.length - 1;
    view.pathPreview.forEach((step, i) => {
      const rect = tileScreenRect(view.camera, step.pos);
      const cx = rect.x + rect.size / 2;
      const cy = rect.y + rect.size / 2;
      if (step.dayBreak || i === last) {
        this.painter.dayMarker(this.ctx, cx, cy, rect.size * 0.24, step.day);
      } else {
        this.painter.pathDot(this.ctx, cx, cy, rect.size * 0.1);
      }
    });
  }
}

// --- minimap ---

export function renderMinimap(
  ctx: CanvasRenderingContext2D,
  view: AdventureView,
  sizePx: number,
  data: GameData,
): void {
  const mapTiles = view.state.map.size;
  const scale = sizePx / mapTiles;
  const terrainByChar = new Map(Object.values(data.terrains).map((t) => [t.char, t]));

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, sizePx, sizePx);
  for (let y = 0; y < mapTiles; y++) {
    for (let x = 0; x < mapTiles; x++) {
      if (!(view.player.explored[y * mapTiles + x] ?? false)) continue;
      const terrain = terrainByChar.get(view.state.map.terrain[y * mapTiles + x] ?? '');
      ctx.fillStyle = terrain?.color ?? '#222222';
      ctx.fillRect(x * scale, y * scale, Math.ceil(scale), Math.ceil(scale));
    }
  }

  const dot = Math.max(2, scale * 1.5);
  for (const obj of view.state.map.objects) {
    const [x, y] = obj.at;
    const index = y * mapTiles + x;
    if (!(view.player.explored[index] ?? false)) continue;
    // fog of war: live ownership only inside current sight, otherwise the
    // viewing player's last-seen snapshot (never leak off-screen captures)
    const inSight = view.visible[index] ?? false;
    const seen = view.player.seenObjects[obj.id];
    const owner = inSight
      ? obj.removed
        ? null
        : obj.owner
      : seen !== undefined && !seen.removed
        ? seen.owner
        : null;
    if (owner === null) continue;
    ctx.fillStyle = PLAYER_COLOR_HEX[owner];
    ctx.fillRect(x * scale - dot / 2 + scale / 2, y * scale - dot / 2 + scale / 2, dot, dot);
  }
  for (const hero of Object.values(view.state.heroes)) {
    const [x, y] = hero.pos;
    if (!(view.visible[y * mapTiles + x] ?? false)) continue;
    ctx.fillStyle = PLAYER_COLOR_HEX[hero.owner];
    ctx.fillRect(x * scale - dot / 2 + scale / 2, y * scale - dot / 2 + scale / 2, dot, dot);
  }

  // viewport rectangle
  const world = worldSizePx(mapTiles);
  const factor = sizePx / world;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    view.camera.x * factor,
    view.camera.y * factor,
    view.camera.width * factor,
    view.camera.height * factor,
  );
}

// minimap pixel position → map tile
export function minimapTile(px: number, py: number, sizePx: number, mapTiles: number): Pos {
  const clamp = (v: number): number => Math.min(mapTiles - 1, Math.max(0, Math.floor(v)));
  return [clamp((px / sizePx) * mapTiles), clamp((py / sizePx) * mapTiles)];
}

export { TILE_PX };
