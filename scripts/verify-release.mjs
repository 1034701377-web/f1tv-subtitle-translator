import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { NODE_VERSION, NODE_ARCHIVE_SHA256, NODE_BASE, NODE_ARCHIVE, sourceRoot,
  allowedReleaseFiles, releaseFiles, wsFiles, sha256, exists, listFiles, powershell, stagingDirectory } from './package-windows.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const packageInfo = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
const archive = resolve(process.argv[2] || join(sourceRoot, 'release', `F1TV-ZH-Windows-x64-v${packageInfo.version}.zip`));
if (process.platform !== 'win32') throw Error('Verify the Windows release on Windows.');
const stage = await stagingDirectory('windows-verify');
let launched;
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const cleanEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: join(systemRoot, 'System32/cmd.exe'),
  PATH: join(systemRoot, 'System32'), TEMP: stage.directory, TMP: stage.directory, F1TV_NO_PAUSE: '1' };

async function freePort() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = 50000 + Math.floor(Math.random() * 10000), probe = net.createServer();
    const opened = await new Promise(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => resolve(true)); });
    if (opened) { await new Promise(resolve => probe.close(resolve)); return port; }
  }
  throw Error('No test port was available.');
}
function launch(root, port) {
  const child = spawn(cleanEnv.COMSPEC, ['/d', '/c', 'start-service.cmd', `--port=${port}`, '--no-open'],
    { cwd: root, env: cleanEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { child.output += data.toString(); });
  child.failure = null; child.once('error', error => { child.failure = error; });
  return child;
}
async function exitCode(child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.failure) throw child.failure;
    if (child.exitCode !== null) return child.exitCode;
    await sleep(100);
  }
  throw Error(`Test launcher did not exit: ${child.output}`);
}
async function json(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200, url); return response.json();
}
async function mismatchedService(root, otherRoot) {
  const port = await freePort(), service = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/health' ? { service: 'f1tv-zh', version: otherRoot ? packageInfo.version : '0.0.0' }
      : { projectRoot: join(root, 'a-different-install') }));
  });
  await new Promise(resolve => service.listen(port, '127.0.0.1', resolve));
  try {
    const child = launch(root, port);
    assert.equal(await exitCode(child), 1);
    assert.equal(service.listening, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
  } finally { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); }
}

try {
  assert.equal(await exists(archive), true, 'The release ZIP is missing.');
  const extracted = join(stage.directory, 'extracted');
  powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $f1Zip=[IO.Compression.ZipFile]::OpenRead($env:F1_ARCHIVE);
    try { if($f1Zip.Entries.Count -gt 200){throw 'Too many archive entries'};
      foreach($f1Entry in $f1Zip.Entries){
        if($f1Entry.FullName -match '(^[/\\\\]|(^|[/\\\\])\\.\\.([/\\\\]|$)|:)' -or $f1Entry.Length -gt 200MB){throw 'Unsafe archive entry'}
      }
    } finally {$f1Zip.Dispose()};
    Expand-Archive -LiteralPath $env:F1_ARCHIVE -DestinationPath $env:F1_EXTRACTED`,
  { F1_ARCHIVE: archive, F1_EXTRACTED: extracted });
  const files = await listFiles(extracted);
  for (const file of files) assert.equal(allowedReleaseFiles.has(file), true, `Unexpected ZIP entry: ${file}`);
  for (const file of [...releaseFiles, ...wsFiles.map(file => `node_modules/ws/${file}`), 'runtime/node.exe', 'runtime/LICENSE', 'runtime/PROVENANCE.json']) assert.ok(files.includes(file), `Missing ZIP entry: ${file}`);
  assert.equal(await exists(join(extracted, '.env')), false);
  for (const file of files.filter(file => file !== 'runtime/node.exe')) {
    const text = await readFile(join(extracted, file), 'utf8');
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]Users[\\/][^\s"'<>]+/i, `Personal profile path in ${file}`);
    assert.equal(text.toLowerCase().includes(sourceRoot.toLowerCase()), false, `Local project path in ${file}`);
    assert.doesNotMatch(text, /\b(?:sk|ds)-[A-Za-z0-9_-]{20,}\b/, `Possible embedded API key in ${file}`);
    assert.doesNotMatch(text, /(?:API_KEY|DASHSCOPE_API_KEY)\s*[:=]\s*['"][A-Za-z0-9._~+/=-]{8,}['"]/, `Credential assignment in ${file}`);
  }
  const node = join(extracted, 'runtime/node.exe');
  const identity = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'], { env: cleanEnv, encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(identity, { version: NODE_VERSION, platform: 'win32', arch: 'x64' });
  const provenance = JSON.parse(await readFile(join(extracted, 'runtime/PROVENANCE.json'), 'utf8'));
  assert.equal(provenance.archive, NODE_BASE + NODE_ARCHIVE);
  assert.equal(provenance.archiveSha256, NODE_ARCHIVE_SHA256);
  assert.equal(provenance.nodeExeSha256, sha256(await readFile(node)));
  const built = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'));
  assert.equal(built.version, packageInfo.version);
  assert.equal(JSON.parse(await readFile(join(extracted, 'dist/chrome-extension/manifest.json'), 'utf8')).version, packageInfo.version);

  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  launched = launch(extracted, port);
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launched.failure || launched.exitCode !== null) throw Error(`Portable launcher failed: ${launched.output}`);
    try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).ok) { healthy = true; break; } } catch {}
    await sleep(100);
  }
  assert.equal(healthy, true, `Portable launcher was not ready: ${launched.output}`);
  const headers = { Origin: base, 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await json(base + '/api/health')).version, packageInfo.version);
  assert.equal((await fetch(base + '/')).status, 200);
  const initial = await json(base + '/api/config', headers);
  assert.equal(initial.translation.configured, false); assert.equal(initial.translation.keySaved, false);
  assert.equal(initial.asr.enabled, false); assert.equal(initial.asr.keySaved, false);
  assert.equal(initial.projectRoot.toLowerCase(), extracted.toLowerCase());
  assert.equal(await exists(join(extracted, '.env')), false, 'Viewing the home page must not create configuration.');
  const session = await json(base + '/api/session', headers);
  const again = launch(extracted, port);
  assert.equal(await exitCode(again), 0, again.output);
  assert.equal((await json(base + '/api/session', headers)).token, session.token);

  const fixtureKeys = { translation: 'release-test-translation-key-0001', asr: 'release-test-asr-key-0002' };
  const input = { translation: { key: fixtureKeys.translation, endpoint: 'https://translation.invalid/chat/completions', model: 'fixture-model', thinking: 'disabled' },
    asr: { key: fixtureKeys.asr, enabled: false, endpoint: 'wss://speech.invalid/inference', model: 'qwen-audio-3.1-asr-flash-streaming' } };
  const post = (origin, body = input) => fetch(base + '/api/config', { method: 'POST', headers: { ...headers, Origin: origin,
    'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: JSON.stringify(body) });
  assert.equal((await post('https://evil.invalid')).status, 403);
  assert.equal(await exists(join(extracted, '.env')), false);
  assert.equal((await post(base)).status, 200);
  const publicConfig = JSON.stringify(await json(base + '/api/config', headers));
  for (const key of Object.values(fixtureKeys)) assert.equal(publicConfig.includes(key), false);
  for (const path of ['/.env', '/local/session.txt', '/lib/settings.mjs', '/docs/Windows使用说明.md']) assert.equal((await fetch(base + encodeURI(path))).status, 404);
  assert.equal((await fetch(base + '/api/config', { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  const saved = await readFile(join(extracted, '.env'), 'utf8');
  assert.equal((await post(base, { ...input, translation: { ...input.translation, endpoint: 'https://translation.invalid/?key=not-public' } })).status, 400);
  assert.equal(await readFile(join(extracted, '.env'), 'utf8'), saved);
  await mismatchedService(extracted, false);
  await mismatchedService(extracted, true);
  console.log(`Verified ${files.length} allowlisted files; official Node ${NODE_VERSION} x64; clean Windows launch without Node/npm PATH; no real API calls; stable second launch; configuration privacy; old-service isolation.`);
} finally {
  if (launched?.pid && launched.exitCode === null) {
    execFileSync(join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(launched.pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true });
    await sleep(300);
  }
  await stage.cleanup();
}
