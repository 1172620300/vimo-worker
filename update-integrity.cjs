'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const source = require('./release.config.json');

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyDownload(files, version, fetcher = fetch) {
  if (!semver.valid(version) || semver.prerelease(version)) throw Error('Invalid release version');
  const expectedName = (source.repo === 'vimo-worker' ? 'Vimo-Worker-Setup-' : 'Vimo-Setup-') + version + '.exe';
  const file = files?.find(f => path.basename(f) === expectedName);
  if (!file) throw Error('Installer missing');
  const url = 'https://github.com/' + source.owner + '/' + source.repo + '/releases/download/v' + version + '/SHA256SUMS.txt';
  const response = await fetcher(url, {signal: AbortSignal.timeout(30000)});
  // Releases created before Phase 1 do not contain SHA256SUMS.txt. The
  // electron-updater SHA512 verification remains authoritative for those.
  if (response.status === 404) return file;
  if (!response.ok) throw Error('Checksum manifest unavailable');
  const text = await response.text();
  if (text.length > 65536) throw Error('Invalid checksum manifest');
  const lines = text.split(/\r?\n/).map(l => l.match(/^([a-fA-F0-9]{64})  (.+)$/)).filter(Boolean);
  const matches = lines.filter(m => m[2] === expectedName);
  if (matches.length !== 1) throw Error('Installer checksum missing or ambiguous');
  if (await hashFile(file) !== matches[0][1].toLowerCase()) {
    await fs.promises.unlink(file);
    throw Error('Installer SHA256 mismatch');
  }
  return file;
}
module.exports = {hashFile, verifyDownload};
