import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const NODE_VERSION = '24.21.0';
export const NODE_ARCHIVE_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
export const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
export const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}/`;
export const releaseFiles = [
  'server.mjs', 'package.json', 'package-lock.json', 'start-service.cmd', 'scripts/start.mjs',
  'lib/glossary.mjs', 'lib/live-translate.mjs', 'lib/qwen-asr.mjs', 'lib/radio-service.mjs',
  'lib/settings.mjs', 'lib/translation-prompt.mjs', 'lib/translator.mjs',
  'app/index.html', 'app/style.css', 'app/app.js', 'dist/f1tv-zh.user.js',
  ...['manifest.json', 'background.js', 'bridge.js', 'offscreen.js', 'offscreen.html', 'pcm-worklet.js',
    'options.html', 'options.css', 'options.js', 'popup.html', 'popup.css', 'popup.js'].map(file => `dist/chrome-extension/${file}`),
  'README.md',
];
export const wsFiles = ['package.json', 'LICENSE', 'browser.js', 'index.js', 'wrapper.mjs',
  ...['buffer-util', 'constants', 'event-target', 'extension', 'limiter', 'permessage-deflate', 'receiver',
    'sender', 'stream', 'subprotocol', 'validation', 'websocket-server', 'websocket'].map(file => `lib/${file}.js`)];
export const allowedReleaseFiles = new Set([...releaseFiles, 'LICENSE', 'runtime/node.exe', 'runtime/LICENSE',
  'runtime/PROVENANCE.json', ...wsFiles.map(file => `node_modules/ws/${file}`)]);
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function powershell(script, environment = {}) {
  return execFileSync(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${script}`],
    { env: { ...process.env, ...environment }, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}
export async function exists(path) { try { await access(path); return true; } catch { return false; } }
export async function listFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error(`Links are not allowed in a release: ${path}`);
    if (entry.isDirectory()) result.push(...await listFiles(root, path));
    else if (entry.isFile()) result.push(path);
    else throw Error(`Unsupported release entry: ${path}`);
  }
  return result.sort();
}
export async function stagingDirectory(purpose) {
  const release = resolve(sourceRoot, 'release');
  await mkdir(release, { recursive: true });
  if ((await realpath(release)).toLowerCase() !== release.toLowerCase()) throw Error('Release directory must not redirect outside this checkout.');
  const directory = join(release, '.staging', `${purpose}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const owner = randomUUID(); await writeFile(join(directory, '.release-owner'), owner);
  return { directory, release, async cleanup() {
    powershell(`$f1Stage=[IO.Path]::GetFullPath($env:F1_STAGE); $f1Allowed=[IO.Path]::GetFullPath($env:F1_STAGE_ROOT).TrimEnd('\\')+'\\';
      if(-not $f1Stage.StartsWith($f1Allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup path'};
      if((Get-Content -LiteralPath (Join-Path $f1Stage '.release-owner') -Raw) -ne $env:F1_STAGE_OWNER){throw 'Unknown staging directory'};
      $f1Resolved=(Resolve-Path -LiteralPath $f1Stage).ProviderPath;
      if(-not $f1Resolved.StartsWith($f1Allowed,[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe resolved cleanup path'};
      Remove-Item -LiteralPath $f1Stage -Recurse -Force`,
    { F1_STAGE: directory, F1_STAGE_ROOT: join(release, '.staging'), F1_STAGE_OWNER: owner });
  } };
}
export async function copyListed(source, target, files) {
  for (const entry of files) {
    const [file, targetFile] = Array.isArray(entry) ? entry : [entry, entry];
    const from = resolve(source, file), to = resolve(target, targetFile);
    if ((await lstat(from)).isSymbolicLink() || !(await lstat(from)).isFile()) throw Error(`Expected ordinary file: ${file}`);
    const actual = await realpath(from), base = await realpath(source);
    if (relative(base, actual).startsWith(`..${sep}`) || relative(base, actual) === '..') throw Error(`File outside source root: ${file}`);
    await mkdir(dirname(to), { recursive: true }); await copyFile(from, to);
  }
}
async function officialFile(name) {
  const response = await fetch(NODE_BASE + name, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Official Node download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function packageWindows() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Build this Windows x64 release on Windows x64.');
  const packageInfo = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(packageInfo.version)) throw Error('Expected a valid release version before packaging.');
  const lock = JSON.parse(await readFile(join(sourceRoot, 'package-lock.json'), 'utf8'));
  if (Object.keys(packageInfo.dependencies || {}).join(',') !== 'ws' || lock.version !== packageInfo.version
      || lock.packages[''].version !== packageInfo.version) throw Error('Package and lockfile are not ready for this release.');
  const server = await readFile(join(sourceRoot, 'server.mjs'), 'utf8');
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'dist/chrome-extension/manifest.json'), 'utf8'));
  const userscript = await readFile(join(sourceRoot, 'dist/f1tv-zh.user.js'), 'utf8');
  if (!server.includes(`VERSION = '${packageInfo.version}'`) || manifest.version !== packageInfo.version
      || !userscript.includes(`// @version      ${packageInfo.version}`)) throw Error('Rebuild and align server, package, userscript and extension versions.');
  const inputs = releaseFiles.map(file => file === 'README.md' ? ['docs/Windows使用说明.md', file] : file);
  for (const item of inputs) { const file = Array.isArray(item) ? item[0] : item; if (!await exists(join(sourceRoot, file))) throw Error(`Missing release input: ${file}`); }
  const stage = await stagingDirectory('windows-package');
  const output = join(stage.release, `F1TV-ZH-Windows-x64-v${packageInfo.version}.zip`);
  try {
    if (await exists(output)) throw Error('Release ZIP already exists; refusing to overwrite it.');
    const payload = join(stage.directory, 'payload'); await mkdir(payload);
    await copyListed(sourceRoot, payload, inputs);
    if (await exists(join(sourceRoot, 'LICENSE'))) await copyListed(sourceRoot, payload, ['LICENSE']);
    console.log(`Downloading official Node.js ${NODE_VERSION} Windows x64...`);
    const checksums = (await officialFile('SHASUMS256.txt')).toString('utf8');
    const checksum = checksums.split(/\r?\n/).find(line => line.endsWith(`  ${NODE_ARCHIVE}`))?.split(/\s+/)[0];
    if (checksum !== NODE_ARCHIVE_SHA256) throw Error('Official Node checksum differs from the pinned release checksum.');
    const archive = await officialFile(NODE_ARCHIVE);
    if (sha256(archive) !== checksum) throw Error('Official Node archive checksum mismatch.');
    const archivePath = join(stage.directory, NODE_ARCHIVE); await writeFile(archivePath, archive);
    const unpacked = join(stage.directory, 'node');
    powershell('Expand-Archive -LiteralPath $env:F1_ARCHIVE -DestinationPath $env:F1_UNPACK', { F1_ARCHIVE: archivePath, F1_UNPACK: unpacked });
    const nodeRoot = join(unpacked, `node-v${NODE_VERSION}-win-x64`), nodeExe = join(nodeRoot, 'node.exe');
    const runtime = JSON.parse(execFileSync(nodeExe, ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'], { encoding: 'utf8', windowsHide: true }));
    if (runtime.version !== NODE_VERSION || runtime.platform !== 'win32' || runtime.arch !== 'x64') throw Error('Unexpected official runtime identity.');
    await copyListed(nodeRoot, join(payload, 'runtime'), ['node.exe', 'LICENSE']);
    await writeFile(join(payload, 'runtime/PROVENANCE.json'), JSON.stringify({ ...runtime, archive: NODE_BASE + NODE_ARCHIVE,
      checksumSource: NODE_BASE + 'SHASUMS256.txt', archiveSha256: checksum, nodeExeSha256: sha256(await readFile(nodeExe)) }, null, 2) + '\n');
    const dependencies = join(stage.directory, 'dependencies'); await mkdir(dependencies);
    await copyListed(sourceRoot, dependencies, ['package.json', 'package-lock.json']);
    console.log('Installing the locked production dependency without lifecycle scripts...');
    execFileSync(nodeExe, [join(nodeRoot, 'node_modules/npm/bin/npm-cli.js'), 'ci', '--omit=dev', '--omit=optional',
      '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dependencies, stdio: 'pipe', windowsHide: true, timeout: 120000 });
    const wsRoot = join(dependencies, 'node_modules/ws');
    const ws = JSON.parse(await readFile(join(wsRoot, 'package.json'), 'utf8'));
    if (ws.name !== 'ws' || ws.version !== lock.packages['node_modules/ws']?.version || ws.license !== 'MIT') throw Error('Unexpected production dependency.');
    await copyListed(wsRoot, join(payload, 'node_modules/ws'), wsFiles);
    for (const file of await listFiles(payload)) if (!allowedReleaseFiles.has(file)) throw Error(`Unapproved release file: ${file}`);
    const zip = join(stage.directory, 'release.zip');
    console.log('Creating the portable ZIP from the allowlisted payload...');
    powershell("Compress-Archive -Path (Join-Path $env:F1_PAYLOAD '*') -DestinationPath $env:F1_ZIP -CompressionLevel Optimal", { F1_PAYLOAD: payload, F1_ZIP: zip });
    powershell(`$f1Target=[IO.Path]::GetFullPath($env:F1_OUTPUT); $f1Allowed=[IO.Path]::GetFullPath($env:F1_RELEASE).TrimEnd('\\')+'\\';
      if(-not $f1Target.StartsWith($f1Allowed,[StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $f1Target)){throw 'Refusing to overwrite release target'};
      Move-Item -LiteralPath $env:F1_ZIP -Destination $f1Target`, { F1_ZIP: zip, F1_OUTPUT: output, F1_RELEASE: stage.release });
    console.log(`Created ${output}`);
    return output;
  } finally { await stage.cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await packageWindows(); } catch (error) { console.error(error.message || 'Windows packaging failed.'); process.exitCode = 1; }
}
