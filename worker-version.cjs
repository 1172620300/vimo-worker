'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const semver = require('semver');
const workerVersion = require('./package.json').version;

function versionSnapshot(state, now = Date.now()) {
  const latest = semver.valid(state.latestVersion);
  return {workerVersion, latestVersion: latest, updateAvailable: !!(latest && semver.gt(latest, workerVersion)),
    updateState: String(state.status || 'unknown'), checkedAt: new Date(now).toISOString()};
}
function writeSnapshot(dir, state) {
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'update-status.json');
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(versionSnapshot(state)));
  fs.renameSync(temporary, file);
}
function heartbeatVersion(dir, now = Date.now()) {
  let snapshot = {};
  try { snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'update-status.json'), 'utf8')); } catch {}
  const age = now - Date.parse(snapshot.checkedAt);
  const fresh = Number.isFinite(age) && age >= 0 && age < 24 * 3600 * 1000 && snapshot.workerVersion === workerVersion;
  const latest = fresh && semver.valid(snapshot.latestVersion) || null;
  return {workerVersion, hostname: os.hostname().slice(0, 80), latestVersion: latest,
    updateAvailable: latest ? semver.gt(latest, workerVersion) : null,
    updateState: fresh ? String(snapshot.updateState || 'unknown').slice(0, 40) : 'unknown'};
}
let nextCheck = 0;
async function refreshRelease(dir, now = Date.now(), fetcher = fetch) {
  if (now < nextCheck) return;
  nextCheck = now + 15 * 60 * 1000;
  try {
    const {owner, repo} = require('./release.config.json');
    const response = await fetcher(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers: {'User-Agent': 'Vimo-Worker', Accept: 'application/vnd.github+json'}, signal: AbortSignal.timeout(4000)});
    if (response.status === 404) { writeSnapshot(dir, {status:'no-release',latestVersion:null}); return; }
    if (!response.ok) return;
    const release = await response.json();
    const version = semver.valid(String(release.tag_name || '').replace(/^v/, ''));
    const assets = new Set((release.assets || []).map(x => x.name));
    if (!version || semver.prerelease(version) || release.draft || release.prerelease ||
        !assets.has(`Vimo-Worker-Setup-${version}.exe`) || !assets.has('latest.yml') || !assets.has('SHA256SUMS.txt')) return;
    const current = heartbeatVersion(dir);
    if (!['downloading','verifying','downloaded'].includes(current.updateState)) {
      writeSnapshot(dir, {status:semver.gt(version,workerVersion)?'available':'current',latestVersion:version});
    }
    nextCheck = now + 6 * 3600 * 1000 + Math.floor(Math.random() * 10 * 60 * 1000);
  } catch { /* Keep the last known version; an update check must not break task execution. */ }
}
module.exports = {versionSnapshot, writeSnapshot, heartbeatVersion, refreshRelease};
