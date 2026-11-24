#!/usr/bin/env node
/**
 * Build and publish a release to the (private) GitHub repository:
 *   node scripts/release.mjs --repo owner/name [--notes "text"] [--draft] [--skip-build]
 *
 * Assets:
 *   ULog-Studio_<v>_x64-setup.exe (+ .sig)   Windows installer, signed for the auto-updater
 *   latest.json                              updater manifest (points to the installer through the GitHub API)
 *   ULog-Studio-<v>.html                     offline single-file web app (open directly in Chrome/Edge)
 *   ULog-Studio-web-<v>.zip                  installable PWA (static files to host anywhere)
 *
 * The updater signing key is read from TAURI_SIGNING_PRIVATE_KEY(_PATH) or %USERPROFILE%/.tauri/ulog-studio.key
 * and never leaves this machine. Requires the GitHub CLI (`gh`) to be authenticated.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const repo = opt('repo', existsSync(join(root, 'update-repo.txt')) ? readFileSync(join(root, 'update-repo.txt'), 'utf8').trim() : '');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.error('Missing --repo owner/name'); process.exit(1); }
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const notes = opt('notes', `ULog Studio ${version}`);
// npm/npx are .cmd shims on Windows and need a shell; everything else (gh, powershell) is run directly so arguments keep their spaces
const needsShell = (cmd) => process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx');
const run = (cmd, a, env = {}) => execFileSync(cmd, a, { cwd: root, stdio: 'inherit', shell: needsShell(cmd), env: { ...process.env, ...env } });
const out = (cmd, a) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8', shell: needsShell(cmd), stdio: ['ignore', 'pipe', 'pipe'] });

writeFileSync(join(root, 'update-repo.txt'), `${repo}\n`);
try { out('gh', ['release', 'view', tag, '--repo', repo]); console.error(`Release ${tag} already exists: bump the version in package.json first.`); process.exit(1); } catch { /* ok, does not exist */ }

const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), '.tauri', 'ulog-studio.key');
const signEnv = {
  ULOG_UPDATE_REPO: repo,
  TAURI_SIGNING_PRIVATE_KEY: process.env.TAURI_SIGNING_PRIVATE_KEY ?? readFileSync(keyPath, 'utf8'),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
};
if (!flag('skip-build')) {
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'build:web']);
  run('npm', ['run', 'build:single']);
  run('npx', ['tauri', 'build'], signEnv);
}

const rel = join(root, 'release', tag);
rmSync(rel, { recursive: true, force: true });
mkdirSync(rel, { recursive: true });
const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const setup = readdirSync(nsisDir).find((f) => f.endsWith(`${version}_x64-setup.exe`));
if (!setup) throw new Error('installer not found');
const setupName = `ULog-Studio_${version}_x64-setup.exe`;
copyFileSync(join(nsisDir, setup), join(rel, setupName));
const signature = readFileSync(join(nsisDir, `${setup}.sig`), 'utf8').trim();
writeFileSync(join(rel, `${setupName}.sig`), signature);
copyFileSync(join(root, 'dist-single', 'index.html'), join(rel, `ULog-Studio-${version}.html`));
const zip = join(rel, `ULog-Studio-web-${version}.zip`);
run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${join(root, 'dist-web')}\\*' -DestinationPath '${zip}' -Force`]);

// 1) create the release with the binaries
run('gh', ['release', 'create', tag, '--repo', repo, '--title', `ULog Studio ${version}`, '--notes', notes,
  ...(flag('draft') ? ['--draft'] : []), join(rel, setupName), join(rel, `${setupName}.sig`), join(rel, `ULog-Studio-${version}.html`), zip]);

// 2) updater manifest pointing at the installer's API URL (works for private repos with a token)
const info = JSON.parse(out('gh', ['api', `repos/${repo}/releases/tags/${tag}`]));
const asset = info.assets.find((a) => a.name === setupName);
if (!asset) throw new Error('uploaded installer not found in release');
const manifest = {
  version, notes, pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { signature, url: asset.url },
    'windows-x86_64-nsis': { signature, url: asset.url },
  },
};
writeFileSync(join(rel, 'latest.json'), JSON.stringify(manifest, null, 2));
run('gh', ['release', 'upload', tag, join(rel, 'latest.json'), '--repo', repo, '--clobber']);
console.log(`\nPublished ${tag} to ${repo}:\n  ${info.html_url}`);
