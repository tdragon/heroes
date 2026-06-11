const app = document.getElementById('app');
if (!app) {
  throw new Error('missing #app root element');
}

const title = document.createElement('div');
title.dataset.testid = 'game-title';
title.textContent = 'Heroes Clone';
title.style.fontSize = '48px';
app.appendChild(title);
