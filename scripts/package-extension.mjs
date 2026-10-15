import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyListed, exists, listFiles, powershell, sourceRoot, stagingDirectory } from './release-utils.mjs';

// Every browser runtime file must be reviewed and named here; never package the repository recursively.
export const extensionFiles = [
  'manifest.json', 'background.js', 'api-router.js', 'rpc-client.js', 'browser-asr.js',
  'document-websocket.js', 'websocket-host.js',
  'import-config.js',
  'settings-store.js', 'model-services.js', 'page.js', 'bridge.js', 'offscreen.js',
  'offscreen.html', 'pcm-worklet.js', 'options.html', 'options.css', 'options.js',
  'popup.html', 'popup.css', 'popup.js',
  ...[16, 32, 48, 128].map(size => `icons/icon${size}.png`),
  ...['core.js', 'track-fx-cues.js', 'tab-audio-source.js', 'capture-protocol.js',
    'programme-relay.js', 'asr-sentences.js'].map(file => `src/${file}`),
  ...['translator.mjs', 'translation-prompt.mjs', 'glossary.mjs'].map(file => `lib/${file}`),
].sort();

function assertFileList(actual, expected, label) {
  const allowed = new Set(expected);
  const found = new Set(actual);
  for (const file of actual) if (!allowed.has(file)) throw Error(`Unapproved ${label} file: ${file}`);
  for (const file of expected) if (!found.has(file)) throw Error(`Missing ${label} file: ${file}`);
}

async function requireDirectDirectory(directory) {
  if (!(await lstat(directory)).isDirectory()
      || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) {
    throw Error(`Release input or staging directory must not redirect: ${directory}`);
  }
}

export async function packageExtension() {
  if (process.platform !== 'win32') throw Error('Build this extension ZIP on Windows with system PowerShell.');
  const packageInfo = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(packageInfo.version)) throw Error('Expected a numeric release version before packaging.');

  const extensionRoot = join(sourceRoot, 'dist', 'chrome-extension');
  await requireDirectDirectory(extensionRoot);
  assertFileList(await listFiles(extensionRoot), extensionFiles, 'extension');
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.version !== packageInfo.version) {
    throw Error('Rebuild the MV3 extension and align its version with package.json.');
  }

  const release = join(sourceRoot, 'release');
  await mkdir(release, { recursive: true });
  await requireDirectDirectory(release);
  const stagingRoot = join(release, '.staging');
  await mkdir(stagingRoot, { recursive: true });
  await requireDirectDirectory(stagingRoot);
  const output = join(release, `F1TV-ZH-Chrome-v${packageInfo.version}.zip`);
  if (await exists(output)) {
    throw Error('Release ZIP already exists.');
  }

  const stage = await stagingDirectory('chrome-extension');
  try {
    await requireDirectDirectory(stage.directory);
    const payload = join(stage.directory, 'payload');
    await mkdir(payload);
    await copyListed(extensionRoot, payload, extensionFiles);
    await copyListed(sourceRoot, payload, ['LICENSE']);
    const expected = [...extensionFiles, 'LICENSE'].sort();
    assertFileList(await listFiles(payload), expected, 'payload');

    const zip = join(stage.directory, 'extension.zip');
    const archiveFiles = JSON.parse(powershell(`
      Compress-Archive -Path (Join-Path $env:F1_PAYLOAD '*') -DestinationPath $env:F1_ZIP -CompressionLevel Optimal;
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      $f1Archive=[IO.Compression.ZipFile]::OpenRead($env:F1_ZIP);
      try { @($f1Archive.Entries | Where-Object { $_.Name } | ForEach-Object { $_.FullName.Replace('\\','/') }) | ConvertTo-Json -Compress }
      finally { $f1Archive.Dispose() }
    `, { F1_PAYLOAD: payload, F1_ZIP: zip }));
    assertFileList(archiveFiles, expected, 'ZIP');

    await copyFile(zip, output, constants.COPYFILE_EXCL);
    console.log(`Created ${output}`);
    return { zip: output };
  } finally {
    await stage.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await packageExtension(); }
  catch (error) { console.error(error.message || 'Extension packaging failed.'); process.exitCode = 1; }
}
