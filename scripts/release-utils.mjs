import { access, copyFile, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
