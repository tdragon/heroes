// Woodcut theme sprite sources: id-keyed raw SVG text.
// Filename convention: terrain/<id>.svg -> "terrain/<id>",
// terrain/road.<id>.svg -> "road/<id>",
// terrain/roadend.<id>.svg -> "roadend/<id>" (rounded dead-end tile).
const files: Record<string, string> = import.meta.glob('./terrain/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function spriteKey(path: string): string {
  const file = path.split('/').pop() ?? path;
  const name = file.replace(/\.svg$/, '');
  if (name.startsWith('roadend.')) return `roadend/${name.slice('roadend.'.length)}`;
  if (name.startsWith('road.')) return `road/${name.slice('road.'.length)}`;
  return `terrain/${name}`;
}

export const woodcutSprites: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, svg]) => [spriteKey(path), svg]),
);
