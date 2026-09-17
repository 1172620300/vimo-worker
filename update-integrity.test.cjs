const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {verifyDownload,hashFile}=require('./update-integrity.cjs');
test('SHA256 accepts the exact product and version, rejects and deletes corrupted downloads',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vimo-checksum-'));
 const name=(require('./release.config.json').repo==='vimo-worker'?'Vimo-Worker-Setup-':'Vimo-Setup-')+'0.1.1.exe';
 const file=path.join(dir,name);
 try {
  fs.writeFileSync(file,'installer');
  const hash=await hashFile(file);
  const fetcher=async url=>{assert.ok(url.endsWith('/v0.1.1/SHA256SUMS.txt'));return {ok:true,text:async()=>hash+'  '+name+'\n'}};
  assert.equal(await verifyDownload([file],'0.1.1',fetcher),file);
  fs.writeFileSync(file,'tampered');
  await assert.rejects(verifyDownload([file],'0.1.1',fetcher),/SHA256 mismatch/);
  assert.equal(fs.existsSync(file),false);
  fs.writeFileSync(file,'installer');
  await assert.rejects(verifyDownload([file],'0.1.1',async()=>({ok:false})),/unavailable/);
  await assert.rejects(verifyDownload([file],'0.1.2',fetcher),/missing/);
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
});
