import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const target = new URL('dist/chrome-extension/', root);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
await mkdir(target, { recursive: true });
async function bundle(inputs) {
  return (await Promise.all(inputs.map(async file => {
    const source = await readFile(new URL(file, root), 'utf8');
    return `// ${file}\n` + source.replace(/^(?:import .*;|export \{.*\} from .*;)\r?\n/gm, '').replace(/^export /gm, '');
  }))).join('\n');
}
// Package only first-party browser code; no server, keys or recordings.
const extensionFiles = ['background.js', 'api-router.js', 'rpc-client.js', 'browser-asr.js', 'document-websocket.js', 'websocket-host.js', 'settings-store.js', 'model-services.js', 'import-config.js',
  'offscreen.html', 'pcm-worklet.js', 'options.html', 'options.css', 'options.js', 'popup.html', 'popup.css', 'popup.js'];
for (const file of extensionFiles) {
  if (file.endsWith('.js')) {
    const source = await readFile(new URL(`extension/${file}`, root), 'utf8');
    await writeFile(new URL(file, target), source.replaceAll("'../src/", "'./src/").replaceAll("'../lib/", "'./lib/"));
  } else await copyFile(new URL(`extension/${file}`, root), new URL(file, target));
}
const browserModules = ['src/core.js', 'src/track-fx-cues.js', 'src/tab-audio-source.js', 'src/capture-protocol.js',
  'src/programme-relay.js', 'src/asr-sentences.js', 'lib/translator.mjs', 'lib/translation-prompt.mjs', 'lib/glossary.mjs'];
for (const file of browserModules) {
  await mkdir(new URL(file.split('/')[0] + '/', target), { recursive: true });
  await copyFile(new URL(file, root), new URL(file, target));
}
await mkdir(new URL('icons/', target), { recursive: true });
for (const size of [16, 32, 48, 128]) await copyFile(new URL(`extension/icons/icon${size}.png`, root), new URL(`icons/icon${size}.png`, target));
const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root), 'utf8'));
await writeFile(new URL('manifest.json', target), JSON.stringify({ ...manifest, version }, null, 2) + '\n');
await writeFile(new URL('bridge.js', target), `(() => {\n${await bundle(['extension/rpc-client.js', 'extension/bridge.js'])}\n})();\n`);
const pageModules = ['extension/page-runtime.js', 'src/core.js', 'src/sources.js', 'src/hls-vtt.js', 'src/tiledmedia-source.js',
  'src/tiledmedia-live-source.js', 'src/track-fx-cues.js', 'src/track-fx-source.js', 'src/capture-mode.js',
  'src/programme-relay.js', 'src/extension-bridge.js', 'src/overlay.js', 'src/floating-controls.js', 'src/preparation-state.js',
  'extension/page-ui.js', 'src/page-entry.js'];
await writeFile(new URL('page.js', target), `(async () => {\n'use strict';\n${await bundle(pageModules)}\n})().catch(error => {
  const notice = document.createElement('div'); notice.dataset.f1zh = 'startup-notice';
  notice.style.cssText = 'position:fixed;right:20px;top:20px;z-index:2147483647;max-width:330px;padding:16px;color:#e5edf4;background:#162331;border:1px solid #547080;border-radius:10px;font:14px/1.6 system-ui';
  notice.textContent = error.message === 'LEGACY_SCRIPT_ACTIVE' ? '请停用旧版 F1 TV 油猴脚本，再刷新本页使用扩展。' : 'F1 TV 中文字幕扩展未能连接，请刷新本页；首次使用请打开扩展设置。';
  document.body.append(notice);
});\n`);
const offscreen = await readFile(new URL('extension/offscreen-entry.js', root), 'utf8');
await writeFile(new URL('offscreen.js', target), offscreen.replaceAll("'../src/", "'./src/"));
console.log(`Built pure extension v${version}: ${fileURLToPath(target)}`);
