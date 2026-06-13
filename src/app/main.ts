import { loadGameData } from '../data';
import { loadMaps } from '../maps';
import { compileMap, type MapSource } from '../maps/dsl';
import { combatArenaSource } from '../maps/fixtures/combat-arena.dsl';
import { tinyMapSource } from '../maps/fixtures/tiny.dsl';
import { newGame } from '../core/setup';
import type { GameState } from '../core/state';
import { AdventureScreen, type ShellCallbacks } from './adventureScreen';
import { disableBrowserZoom } from './disableBrowserZoom';
import { MainMenu } from './mainMenu';
import { NewGameSetup } from './newGameSetup';
import { ScreenRouter } from './screens';

const app = document.getElementById('app');
if (!app) {
  throw new Error('missing #app root element');
}

disableBrowserZoom();

const data = loadGameData();
const fixtureSources: readonly MapSource[] = [tinyMapSource, combatArenaSource];
const allMaps = [...loadMaps(), ...fixtureSources.map((source) => compileMap(source, data))];

const router = new ScreenRouter(app);

const shell: ShellCallbacks = {
  onExit: () => {
    router.show('main-menu');
  },
  onLoad: (state) => {
    startGame(state);
  },
  storage: window.localStorage,
};

function startGame(state: GameState): void {
  router.register('adventure', new AdventureScreen(data, state, shell));
  router.show('adventure');
}

router.register(
  'main-menu',
  new MainMenu(window.localStorage, {
    onNewGame: () => {
      router.show('new-game');
    },
    onLoadGame: startGame,
  }),
);

router.register(
  'new-game',
  new NewGameSetup(data, allMaps, {
    onStart: (map, difficulty, seed) => {
      startGame(newGame(map, { difficulty }, seed, data));
    },
    onBack: () => {
      router.show('main-menu');
    },
  }),
);

// dev/e2e direct boot: ?map=<id>&seed=<n> skips the menu
const params = new URLSearchParams(window.location.search);
const mapId = params.get('map');
// '?map=' with an empty value means "no map": fall back to the menu
if (mapId !== null && mapId !== '') {
  const seedParam = Number(params.get('seed') ?? '');
  const seed = Number.isFinite(seedParam) && params.get('seed') !== null ? seedParam : 42;
  const map = allMaps.find((m) => m.id === mapId);
  if (!map) {
    throw new Error(`unknown map: ${mapId}`);
  }
  startGame(newGame(map, {}, seed, data));
} else {
  router.show('main-menu');
}
