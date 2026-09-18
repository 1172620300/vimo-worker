const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {writeSnapshot,heartbeatVersion}=require('./worker-version.cjs');
test('unknown and stale releases are not reported as up to date',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vimo-version-'));
 try {
  assert.equal(heartbeatVersion(dir).updateAvailable,null);
  writeSnapshot(dir,{latestVersion:'0.1.2',status:'available'});
  assert.equal(heartbeatVersion(dir).workerVersion,require('./package.json').version);
  assert.equal(heartbeatVersion(dir).updateAvailable,true);
  assert.equal(heartbeatVersion(dir,Date.now()+25*3600000).updateAvailable,null);
  writeSnapshot(dir,{latestVersion:'garbage',status:'error'});
  assert.equal(heartbeatVersion(dir).latestVersion,null);
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
