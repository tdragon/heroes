// Woodcut theme sprite sources: id-keyed raw SVG text.
// The folder names the sprite category:
//   terrain/<id>.svg -> "terrain/<id>"
//   terrain/road.<id>.svg -> "road/<id>"
//   terrain/roadend.<id>.svg -> "roadend/<id>" (rounded dead-end tile)
//   terrain/roadbend.<id>.svg -> "roadbend/<id>" (smooth 90° corner tile)
//   creatures/<id>.svg -> "creature/<id>"
//   heroes/<id>.svg -> "hero/<id>"
//   resources/<id>.svg -> "resource/<id>"
//   objects/<type>.svg -> "object/<type>"
//   buildings/<id>.svg -> "building/<id>"
const files: Record<string, string> = import.meta.glob('./*/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const folderCategory: Record<string, string> = {
  terrain: 'terrain',
  creatures: 'creature',
  heroes: 'hero',
  resources: 'resource',
  objects: 'object',
  buildings: 'building',
};

function spriteKey(path: string): string {
  const parts = path.split('/');
  const file = parts.pop() ?? path;
  const folder = parts.pop() ?? '';
  const name = file.replace(/\.svg$/, '');
  const category = folderCategory[folder] ?? folder;
  if (category === 'terrain') {
    if (name.startsWith('roadbend.')) return `roadbend/${name.slice('roadbend.'.length)}`;
    if (name.startsWith('roadend.')) return `roadend/${name.slice('roadend.'.length)}`;
    if (name.startsWith('road.')) return `road/${name.slice('road.'.length)}`;
  }
  return `${category}/${name}`;
}

export const woodcutSprites: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, svg]) => [spriteKey(path), svg]),
);
