import { loadGameData } from '../data';
import { getMap } from '../maps';
import { compileMap, type MapSource } from '../maps/dsl';
import { combatArenaSource } from '../maps/fixtures/combat-arena.dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { newGame } from '../core/setup';
import { AdventureScreen } from './adventureScreen';
import { ScreenRouter } from './screens';

const app = document.getElementById('app');
if (!app) {
  throw new Error('missing #app root element');
}

const data = loadGameData();

// dev/e2e boot parameters until the Task 17 main menu lands: ?map=<id>&seed=<n>
const params = new URLSearchParams(window.location.search);
const mapId = params.get('map') ?? 'tutorial-valley';
const seedParam = Number(params.get('seed') ?? '');
const seed = Number.isFinite(seedParam) && params.get('seed') !== null ? seedParam : 42;

const fixtureSources: readonly MapSource[] = [tinyMapSource, combatArenaSource];
const fixture = fixtureSources.find((source) => source.id === mapId);
const map = fixture ? compileMap(fixture, data) : getMap(mapId);
const state = newGame(map, {}, seed, data);

const router = new ScreenRouter(app);
router.register('adventure', new AdventureScreen(data, state));
router.show('adventure');
