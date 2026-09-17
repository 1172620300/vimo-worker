'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const source = require('../release.config.json');
const pkg = require('../package.json');
const {hashFile} = require('../update-integrity.cjs');
const publish = process.argv.includes('--publish');
const version = pkg.version;
const tag = 'v' + version;
const worker = source.repo === 'vimo-worker';
const installer = (worker ? 'Vimo-Worker-Setup-' : 'Vimo-Setup-') + version + '.exe';
function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], {stdio: 'inherit'});
  if (result.status !== 0) throw Error('Build failed');
}
async function api(url, method = 'GET', body, contentType = 'application/json') {
  const response = await fetch(url, {method, redirect: 'error', signal: AbortSignal.timeout(300000),
    headers: {Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json',
      'Content-Type': contentType, 'User-Agent': 'Vimo-Release'},
    body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body});
  if (!response.ok) throw Error('GitHub release request failed: HTTP ' + response.status);
  return response.json();
}
async function main() {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) throw Error('Stable x.y.z version required');
  if (!/^[\w.-]+$/.test(source.owner) || !['vimo-worker','vimo-desktop'].includes(source.repo)) throw Error('Unexpected release repository');
  if (pkg.name !== (worker ? 'vimo-worker-client' : 'scene-studio-ui')) throw Error('Product and release repository do not match');
  if (require('../package-lock.json').version !== version) throw Error('Lockfile version mismatch');
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== tag) throw Error('Tag/version mismatch');
  if (publish && (!process.env.GH_TOKEN || process.env.GITHUB_REF_TYPE !== 'tag')) throw Error('Publish from a matching GitHub tag with GH_TOKEN');
  const base = 'https://api.github.com/repos/' + source.owner + '/' + source.repo;
  if (publish) {
    const response = await fetch(base + '/releases/tags/' + tag, {headers: {Authorization: 'Bearer ' + process.env.GH_TOKEN}, signal: AbortSignal.timeout(30000)});
    if (response.status !== 404) throw Error('Release already exists or cannot verify uniqueness; never overwrite a release');
  }
  const out = path.join(root, 'dist');
  if (path.dirname(out) !== root) throw Error('Invalid output path');
  fs.rmSync(out, {recursive: true, force: true});
  if (!worker) run('canvas-app/build.cjs', []);
  run('node_modules/electron-builder/out/cli/cli.js', ['--win','nsis','--x64','--config','electron-builder.cjs','--publish','never']);
  const files = [installer, installer + '.blockmap', 'latest.yml'];
  for (const name of files) if (!fs.existsSync(path.join(out, name))) throw Error('Missing artifact: ' + name);
  const yaml = require('js-yaml').load(fs.readFileSync(path.join(out, 'latest.yml'), 'utf8'));
  if (yaml.version !== version || !yaml.files?.some(f => f.url === installer)) throw Error('Update metadata mismatch');
  const sums = [];
  for (const name of files) sums.push(await hashFile(path.join(out, name)) + '  ' + name);
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  console.log('Built and checksummed ' + installer);
  if (!publish) return;
  const release = await api(base + '/releases', 'POST', {tag_name: tag, target_commitish: process.env.GITHUB_SHA,
    name: (worker ? 'Vimo Worker ' : 'Vimo Desktop ') + tag, draft: true, prerelease: false,
    generate_release_notes: true, body: worker ? '独立 Worker 发布；支持版本检查、下载校验和版本上报。请在维护窗口人工安装，自动重启升级尚未启用。' : '独立 Desktop 发布；新增安装包 SHA256 校验。'});
  // Failed uploads leave a draft so clients cannot discover an incomplete release.
  for (const name of [...files, 'SHA256SUMS.txt']) {
    await api('https://uploads.github.com/repos/' + source.owner + '/' + source.repo + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(name),
      'POST', fs.readFileSync(path.join(out, name)), 'application/octet-stream');
  }
  await api(base + '/releases/' + release.id, 'PATCH', {draft: false, make_latest: 'true'});
  console.log('Published ' + source.repo + ' ' + tag);
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
