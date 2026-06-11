import { loadGameData } from '../data';
import { getMap } from '../maps';
import { newGame } from '../core/setup';
import { AdventureScreen } from './adventureScreen';
import { ScreenRouter } from './screens';

const app = document.getElementById('app');
if (!app) {
  throw new Error('missing #app root element');
}

const data = loadGameData();
const map = getMap('tutorial-valley');
const state = newGame(map, {}, 42, data);

const router = new ScreenRouter(app);
router.register('adventure', new AdventureScreen(data, state));
router.show('adventure');
