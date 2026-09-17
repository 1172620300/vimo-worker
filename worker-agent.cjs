'use strict';
const fs=require('node:fs'),path=require('node:path');
const {tcp}=require('./tunnel-manager.cjs');
const dir=__dirname,config=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
function read(name){try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))}catch{return null}}
function write(name,value){const p=path.join(dir,name);fs.writeFileSync(p+'.tmp',JSON.stringify(value,null,2));fs.renameSync(p+'.tmp',p)}
function log(message){fs.appendFileSync(path.join(dir,'logs','worker-agent.log'),`${new Date().toISOString()} ${message}\n`)}
async function request(route,body,token){const r=await fetch(config.schedulerUrl+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(`${r.status}: ${typeof data.detail==='string'?data.detail:'Scheduler request failed'}`);return data}
let lastError=null,lastSuccess=null,lease=null,lastReallocate=0;
async function tick(){
 const credential=read('secrets/enrollment.json'),local=read('status.json');
 const state={updatedAt:new Date().toISOString(),pid:process.pid,lastHeartbeat:lastSuccess,lastError,lease,state:'Starting'};
 try{
  if(!credential){state.state='Enrollment required';return}
  if(!local||Date.now()-Date.parse(local.updatedAt)>20000){state.state='Supervisor unavailable';return}
  if(!local.localComfy?.ready){state.state='ComfyUI Offline';return}
  const server=lease?.ssh_host||credential.ssh_host;
  if(!await tcp(server,lease?.ssh_port||22)){state.state='SSH server unreachable';return}
  const core=local.components.core;
  if(core.portConflict&&core.failures>=3&&Date.now()-lastReallocate>60000){lastReallocate=Date.now();try{lease=await request('/workers/reallocate',{},credential.device_token);log('New remote port allocated: '+lease.tunnel_port)}catch(e){log('Port reallocation: '+e.message)}}
  const response=await request('/workers/heartbeat',{comfy_ready:true,tunnel_connected:!!core.confirmed,gpu_ready:local.localComfy.gpuReady,busy:local.localComfy.busy,local_url:local.localComfy.url,last_error:core.lastError?.slice(0,1000)||null},credential.device_token);
  lease=response;lastSuccess=new Date().toISOString();lastError=null;state.state=response.state;state.lease=lease;state.lastHeartbeat=lastSuccess;state.lastError=null;
 }catch(e){lastError=e.message;state.lastError=lastError;state.state='Reconnecting';log(e.message)}finally{state.updatedAt=new Date().toISOString();write('agent-status.json',state)}
}
async function run(){log('Agent started PID='+process.pid);while(true){await tick();await new Promise(r=>setTimeout(r,10000))}}
run().catch(e=>{log(e.message);process.exitCode=1});
