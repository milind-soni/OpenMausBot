import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const screenshotsSource = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
const screenshotsTarget = fileURLToPath(new URL('../public/screenshots/', import.meta.url));
const iconSource = fileURLToPath(new URL('../../../public/app-icon.svg', import.meta.url));
const iconTarget = fileURLToPath(new URL('../public/app-icon.svg', import.meta.url));

await mkdir(screenshotsTarget, { recursive: true });

for (const name of await readdir(screenshotsSource)) {
  if (!/\.(png|jpe?g|webp)$/i.test(name)) continue;
  await copyFile(`${screenshotsSource}/${name}`, `${screenshotsTarget}/${name}`);
}

await copyFile(iconSource, iconTarget);
