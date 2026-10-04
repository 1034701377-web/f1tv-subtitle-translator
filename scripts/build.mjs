// Tiny deterministic bundle for our named-export-only modules. No downloaded
// dependencies, runtime eval, external CDN or userscript @require.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const files = ['src/core.js', 'src/sources.js', 'src/hls-vtt.js', 'src/tiledmedia-source.js', 'src/tiledmedia-live-source.js', 'src/track-fx-cues.js', 'src/track-fx-source.js', 'src/capture-mode.js', 'src/programme-relay.js', 'src/extension-bridge.js', 'src/overlay.js', 'src/floating-controls.js', 'src/asr-client.js', 'src/radio-client.js', 'src/preparation-state.js', 'src/userscript-entry.js'];
const header = `// ==UserScript==
// @name         F1 TV 中文字幕
// @namespace    local.f1tv.zh
// @version      ${version}
// @description  翻译官方解说字幕及独立采集页的 Track FX 声音，中文按节目时间显示。
// @match        https://f1tv.formula1.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      127.0.0.1
// @noframes
// ==/UserScript==
`;
async function bundle(inputs) {
  const modules = await Promise.all(inputs.map(async file => {
  const text = await readFile(new URL(file, root), 'utf8');
  return `// ${file}\n` + text.replace(/^(?:import .*;|export \{.*\} from .*;)\r?\n/gm, '').replace(/^export /gm, '');
  }));
  return modules.join('\n');
}
await mkdir(new URL('dist/', root), {recursive:true});
const target = new URL('dist/f1tv-zh.user.js', root);
await writeFile(target, `${header}\n(() => {\n'use strict';\n${await bundle(files)}\n})();\n`);
console.log(`Built ${fileURLToPath(target)}`);
const extensionTarget = new URL('dist/chrome-extension/', root);
await mkdir(extensionTarget, { recursive: true });
// Explicit allowlist: never copy .env, credentials, recordings or the workspace.
for (const file of ['offscreen.html', 'pcm-worklet.js', 'options.html', 'options.css', 'options.js', 'popup.html', 'popup.css', 'popup.js']) {
  await copyFile(new URL(`extension/${file}`, root), new URL(file, extensionTarget));
}
const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root), 'utf8'));
await writeFile(new URL('manifest.json', extensionTarget), JSON.stringify({ ...manifest, version }, null, 2) + '\n');
await writeFile(new URL('background.js', extensionTarget), await bundle(['src/capture-protocol.js', 'extension/background.js']));
await writeFile(new URL('bridge.js', extensionTarget), await bundle(['extension/bridge.js']));
await writeFile(new URL('offscreen.js', extensionTarget), await bundle([
  'src/core.js', 'src/track-fx-cues.js', 'src/tab-audio-source.js', 'src/asr-client.js', 'src/capture-protocol.js', 'src/programme-relay.js', 'extension/offscreen-entry.js'
]));
console.log(`Built ${fileURLToPath(extensionTarget)}`);
