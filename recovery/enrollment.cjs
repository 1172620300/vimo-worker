'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {execFile}=require('node:child_process');
let inFlight=null;
async function enroll(account,app){
 const dir=require('../runtime-paths.cjs').dataDir(app.getPath('userData')),config=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
 const credentialFile=path.join(dir,'secrets','enrollment.json');
 if(fs.existsSync(credentialFile))return;
 const secretDir=path.dirname(credentialFile);fs.mkdirSync(secretDir,{recursive:true});
 if(!fs.existsSync(config.workerKey))await new Promise((resolve,reject)=>execFile(config.ssh.replace(/ssh\.exe$/i,'ssh-keygen.exe'),['-t','ed25519','-N','','-f',config.workerKey,'-C','vimo-worker'],{windowsHide:true},e=>e?reject(e):resolve()));
 const deviceFile=path.join(app.getPath('userData'),'worker-installation-id');
 let id=fs.existsSync(deviceFile)?fs.readFileSync(deviceFile,'utf8').trim():crypto.randomUUID();
 if(!fs.existsSync(deviceFile))fs.writeFileSync(deviceFile,id,{flag:'wx'});
 const token=account.credentials().apiKey;
 async function request(route,body){const r=await fetch(config.schedulerUrl+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(typeof data.detail==='string'?data.detail:`Enrollment failed (${r.status})`);return data}
 await request('/auth/worker/device',{installation_id:id,name:os.hostname().slice(0,80)});
 const publicKey=fs.readFileSync(config.workerKey+'.pub','utf8').trim().split(/\s+/).slice(0,2).join(' ');
 const credential=await request('/workers/register',{installation_id:id,public_key:publicKey});
 fs.writeFileSync(credentialFile+'.tmp',JSON.stringify(credential));fs.renameSync(credentialFile+'.tmp',credentialFile);
}
module.exports={ensure:(account,app)=>inFlight||(inFlight=enroll(account,app).finally(()=>{inFlight=null}))};
