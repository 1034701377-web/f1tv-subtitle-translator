import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
async function scripts(directory) {
  const files = [];
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await scripts(path));
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}
const files = [...await scripts('lib'), ...await scripts('src'),
  ...await scripts('extension'), ...await scripts('scripts'), ...await scripts('tests'), ...await scripts('dist/chrome-extension')];
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(path, root))], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('dist/chrome-extension/manifest.json', root), 'utf8'));
const page = await readFile(new URL('dist/chrome-extension/page.js', root), 'utf8');
if (manifest.version !== version) throw Error('Build versions differ; run npm run build.');
if (/class (SimulatedSource|MappedCueSource|CommentarySync)\b/.test(page)) throw Error('Experimental code found in page adapter.');
if (/GM_xmlhttpRequest|GM_getValue|127\.0\.0\.1/.test(page)) throw Error('Legacy runtime dependency found in page adapter.');
console.log(`Checked ${files.length} scripts and matching v${version} build outputs.`);
