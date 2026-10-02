import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const files = ['core', 'sources', 'hls-vtt', 'tiledmedia-source', 'tiledmedia-live-source', 'overlay', 'floating-controls', 'preparation-state', 'userscript-entry'];
const header = `// ==UserScript==
// @name         F1 TV 字幕翻译
// @namespace    https://github.com/1034701377-web/f1tv-subtitle-translator
// @version      ${version}
// @description  将 F1 TV 官方英文解说字幕提前翻译为简体中文，按观看时间显示。
// @homepageURL  https://github.com/1034701377-web/f1tv-subtitle-translator
// @downloadURL  https://raw.githubusercontent.com/1034701377-web/f1tv-subtitle-translator/main/dist/f1tv-zh.user.js
// @updateURL    https://raw.githubusercontent.com/1034701377-web/f1tv-subtitle-translator/main/dist/f1tv-zh.user.js
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
const modules = await Promise.all(files.map(async name => {
  const content = await readFile(new URL(`src/${name}.js`, root), 'utf8');
  return `// src/${name}.js\n` + content.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
}));
await mkdir(new URL('dist/', root), {recursive:true});
await writeFile(new URL('dist/f1tv-zh.user.js', root), `${header}\n(() => {\n'use strict';\n${modules.join('\n')}\n})();\n`);
console.log(`F1 TV 字幕翻译 v${version} 已构建。`);
