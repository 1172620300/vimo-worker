'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function dataDir(userData) {
  if (process.env.VIMO_WORKER_HOME) {
    if (!path.isAbsolute(process.env.VIMO_WORKER_HOME)) throw Error('VIMO_WORKER_HOME must be absolute');
    return process.env.VIMO_WORKER_HOME;
  }
  // Keep explicitly configured source deployments working without copying credentials.
  const legacy = path.join(__dirname, 'recovery');
  if (!__dirname.includes('app.asar') && fs.existsSync(path.join(legacy, 'config.json'))) return legacy;
  return path.join(userData || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'vimo-worker-client'), 'recovery');
}
module.exports = {dataDir};
