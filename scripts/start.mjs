import { access, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameDirectory = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
let child;

function options(args) {
  let port = 3847, open = true;
  for (const argument of args) {
    if (argument === '--no-open') open = false;
    else if (argument === '--open') open = true;
    else if (/^--port=\d+$/.test(argument)) port = Number(argument.slice(7));
    else throw Error(`不支持的启动参数：${argument}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('端口必须在 1–65535 之间。');
  return { port, open };
}
function openHome(url) {
  if (process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, error => {
    if (error) console.log(`请在浏览器打开 ${url}`);
  });
  else console.log(`请在浏览器打开 ${url}`);
}
async function existingService(url) {
  let health;
  try {
    const response = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    if (!response.ok) throw Error('OTHER_SERVICE');
    health = await response.json();
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw Error('此端口已有服务或暂时没有响应。请先查看原服务窗口，不会自动关闭其他进程。');
  }
  if (health.service !== 'f1tv-zh' || health.version !== packageInfo.version) throw Error('此端口运行着其他服务或旧版 F1 TV 翻译系统。请手动关闭旧窗口后重试；不会自动结束进程。');
  try {
    const response = await fetch(`${url}api/config`, { headers: { Origin: url.slice(0, -1), 'Sec-Fetch-Site': 'same-origin' }, signal: AbortSignal.timeout(2500), redirect: 'error' });
    if (!response.ok) throw Error('OLD_SERVICE');
    const config = await response.json();
    if (typeof config.projectRoot !== 'string' || !sameDirectory(config.projectRoot, root)) throw Error('OTHER_DIRECTORY');
  } catch {
    throw Error('此端口运行的服务来自其他文件夹，或版本不支持路径确认。请手动关闭原服务后重试；不会自动结束进程。');
  }
  return true;
}

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('需要 Node.js 22 或更新版本；普通用户请下载 Windows 便携包。');
  const { port, open } = options(process.argv.slice(2)), url = `http://127.0.0.1:${port}/`;
  const bundled = resolve(root, 'runtime/node.exe');
  let bundledExists = false;
  try { await access(bundled); bundledExists = true; } catch {}
  if (bundledExists && !sameDirectory(process.execPath, bundled)) {
    const retry = spawn(bundled, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', windowsHide: true });
    process.exitCode = await new Promise((resolve, reject) => { retry.once('error', reject); retry.once('exit', code => resolve(code ?? 1)); });
  } else if (await existingService(url)) {
    console.log(`系统已在本文件夹运行：${url}`);
    if (open) openHome(url);
  } else {
    for (const file of ['node_modules/ws/package.json', 'dist/f1tv-zh.user.js', 'dist/chrome-extension/manifest.json', 'app/index.html']) {
      try { await access(resolve(root, file)); }
      catch { throw Error('文件不完整。便携包请重新完整解压；源码开发请先运行 npm ci 和 npm run build。'); }
    }
    child = spawn(process.execPath, [resolve(root, 'server.mjs'), `--port=${port}`], { cwd: root, stdio: 'inherit', windowsHide: true });
    let ended = false;
    const endedPromise = new Promise((resolve, reject) => {
      child.once('error', error => { ended = true; reject(error); });
      child.once('exit', code => { ended = true; resolve(code ?? 1); });
    });
    endedPromise.catch(() => {});
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ended; attempt++) {
      await pause(200);
      if (ended) break;
      if (await existingService(url)) { ready = true; break; }
    }
    if (!ready) throw Error('服务未能启动。请查看上方提示；如端口被占用，请手动关闭原服务。');
    console.log('观看期间请保持此窗口打开。关闭窗口或按 Ctrl+C 会停止本机翻译服务。');
    if (open) openHome(url);
    process.once('SIGINT', () => child?.kill('SIGINT'));
    process.once('SIGTERM', () => child?.kill('SIGTERM'));
    process.exitCode = await endedPromise;
  }
} catch (error) {
  // Only a child created by this launcher can be stopped here.
  child?.kill();
  console.error(error.message || '启动失败。请重新解压便携包后重试。');
  process.exitCode = 1;
}
