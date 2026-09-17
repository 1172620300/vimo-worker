'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn,execFileSync}=require('node:child_process');
const {TunnelManager,available,freePort,retryDelay,alive}=require('./tunnel-manager.cjs');
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function write(file,data){fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2));fs.renameSync(file+'.tmp',file)}
async function json(url){try{const r=await fetch(url,{signal:AbortSignal.timeout(2500)});return r.ok?await r.json():null}catch{return null}}
function inventory(){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'ssh.exe','python.exe','pythonw.exe','node.exe' } | Select-Object ProcessId,CommandLine,ExecutablePath) | ConvertTo-Json -Compress"],{windowsHide:true,encoding:'utf8',timeout:15000})||'[]')}
function detectedEndpoints(rows){const candidates=[];for(const row of rows){const cmd=row.CommandLine||'';if(!/main\.py/i.test(cmd)||!/comfy/i.test(cmd))continue;const port=Number(cmd.match(/--port(?:=|\s+)["']?(\d+)/)?.[1]||8188);let host=cmd.match(/--listen(?:=|\s+)["']?([\d.:]+)/)?.[1]||'127.0.0.1';if(host==='0.0.0.0')host='127.0.0.1';if(host==='::')host='::1';if(port>0&&port<65536)candidates.push({host,port,pid:row.ProcessId})}return candidates}
const urlFor=e=>`http://${e.host.includes(':')?'['+e.host+']':e.host}:${e.port}`;
class Supervisor{
 constructor(config,dir){this.config=config;this.dir=dir;this.startedAt=new Date().toISOString();fs.mkdirSync(path.join(dir,'logs'),{recursive:true});this.core=new TunnelManager('core',config,dir);this.admin=new TunnelManager('admin',config,dir);this.components={comfy:{state:'Starting',pid:null,failures:0,nextRetry:0},agent:{state:'Starting',pid:null,failures:0,nextRetry:0}};this.rows=[];this.localComfy={ready:false};this.lastInventory=0;this.adminPort=null;}
 log(name,message){fs.appendFileSync(path.join(this.dir,'logs',name==='comfy'?'comfyui.log':'worker.log'),`${new Date().toISOString()} ${message}\n`)}
 start(name,file,args,cwd){const c=this.components[name];c.state='Starting';c.startedAt=new Date().toISOString();const child=spawn(file,args,{windowsHide:true,cwd,stdio:['ignore','pipe','pipe'],env:{...process.env,H3_DISABLE_DIRECT_FILE_READ:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1'}});c.child=child;c.pid=child.pid;this.log(name,`${name} start PID=${child.pid}`);for(const stream of [child.stdout,child.stderr])stream.on('data',b=>this.log(name,b.toString().trimEnd()));child.once('error',e=>{c.lastError=e.message});child.once('close',code=>{if(c.child!==child)return;c.child=null;c.pid=null;c.failures++;c.state='Reconnecting';c.lastExitCode=code;c.nextRetry=Date.now()+retryDelay(c.failures);this.log(name,`${name} exit=${code}; retry=${retryDelay(c.failures)}ms`)})}
 async discover(){
  if(Date.now()-this.lastInventory>15000){this.rows=inventory();this.lastInventory=Date.now()}
  const discovered=detectedEndpoints(this.rows),configured=this.config.comfyEndpoint;
  const endpoints=configured?[configured]:[...discovered,...(this.config.comfyCandidates||[])];
  const seen=new Set();for(const e of endpoints){const url=urlFor(e);if(seen.has(url))continue;seen.add(url);const stats=await json(url+'/system_stats');if(stats?.system&&Array.isArray(stats.devices)){const queue=await json(url+'/queue');const argv=stats.system.argv||[];const proc=this.rows.find(p=>p.ProcessId===e.pid);if(proc?.ExecutablePath&&argv[0]&&path.isAbsolute(argv[0])&&fs.existsSync(argv[0])){const launch={python:proc.ExecutablePath,argv,endpoint:{host:e.host,port:e.port},comfyRoot:path.dirname(argv[0]),outputDir:argv.includes('--output-directory')?argv[argv.indexOf('--output-directory')+1]:this.config.outputDir};write(path.join(this.dir,'comfy-launch.json'),launch)}return {...e,url,ready:true,gpuReady:stats.devices.some(d=>['cuda','mps','xpu'].includes(d.type)),busy:!!queue?.queue_running?.length,currentTasks:queue?.queue_running?.map(t=>t[1])||[]}}}
  return {ready:false,candidates:endpoints};
 }
 async comfy(){const c=this.components.comfy;this.localComfy=await this.discover();if(this.localComfy.ready){c.state='Ready';c.pid=this.localComfy.pid||c.pid;c.failures=0;c.lastSuccess=new Date().toISOString();return}
  if(c.pid&&alive(c.pid)){c.state='Starting / Unhealthy';return}
  const existing=detectedEndpoints(this.rows).find(e=>alive(e.pid));if(existing){c.pid=existing.pid;c.state='Starting / Unhealthy';return}
  if(Date.now()<c.nextRetry)return;
  if(!this.config.autoStartComfy){c.state='ComfyUI not found';return}
  const launch=read(path.join(this.dir,'comfy-launch.json'))||this.config;
  const target=this.config.comfyEndpoint||launch.endpoint||this.config.comfyCandidates[0];let port=target.port;
  if(!await available(port)){if(this.config.comfyEndpoint){c.state='Configured port occupied';return}port=await freePort(this.config.comfyStartPorts);if(!port){c.state='No free ComfyUI port';return}}
  if(!fs.existsSync(launch.python)||!fs.existsSync(path.join(launch.comfyRoot,'main.py'))){c.state='ComfyUI installation missing';return}
  const args=launch.argv?[...launch.argv]:[path.join(launch.comfyRoot,'main.py'),'--base-directory',launch.comfyRoot,'--output-directory',launch.outputDir,'--disable-auto-launch'];
  for(const [flag,value] of [['--listen',target.host],['--port',String(port)]]){const index=args.findIndex(a=>a===flag||a.startsWith(flag+'='));if(index<0)args.push(flag,value);else if(args[index].includes('='))args[index]=flag+'='+value;else if(args[index+1]&&!args[index+1].startsWith('--'))args[index+1]=value;else args.splice(index+1,0,value)}
  this.start('comfy',launch.python,['-X','utf8',...args],launch.comfyRoot);
 }
 async tick(){
  try{await this.comfy()}catch(e){this.log('comfy',e.message);this.localComfy={ready:false};this.components.comfy.lastError=e.message}
  const agentProc=this.components.agent;if(!agentProc.pid||!alive(agentProc.pid)){if(Date.now()>=agentProc.nextRetry)this.start('agent',process.execPath,[path.join(this.dir,'worker-agent.cjs')],this.dir)}
  const agent=read(path.join(this.dir,'agent-status.json'));
  const agentFresh=agent&&Date.now()-Date.parse(agent.updatedAt)<35000&&alive(agent.pid);
  agentProc.state=agentFresh?'Running':'Starting / Unresponsive';
  const lease=agent?.lease;
  // Existing allocations remain usable through brief scheduler outages. Ready requires a fresh verified heartbeat.
  const target=this.localComfy.ready&&lease?{host:this.localComfy.host,port:this.localComfy.port,remotePort:lease.tunnel_port,server:lease.ssh_user+'@'+lease.ssh_host,sshPort:lease.ssh_port}:null;
  await this.core.tick(target);
  try{if(this.config.adminEnabled){if(!this.admin.state.pid&&Date.now()>=this.admin.state.nextRetry)this.adminPort=await freePort(this.config.adminPorts);if(this.adminPort)await this.admin.tick({host:'127.0.0.1',port:this.adminPort,remotePort:this.config.adminRemotePort,server:this.config.adminServer,sshPort:this.config.adminSshPort});else {this.admin.state.state='No free admin port';this.admin.state.nextRetry=Date.now()+30000}}else this.admin.state.state='Disabled'}catch(e){this.admin.state.lastError=e.message;this.log('worker','Admin error: '+e.message)}
  const online=agentFresh&&agent.lastHeartbeat&&Date.now()-Date.parse(agent.lastHeartbeat)<35000;
  const ready=!!(online&&lease?.ready&&this.core.confirmed&&this.localComfy.ready);
  const state={updatedAt:new Date().toISOString(),startedAt:this.startedAt,supervisorPid:process.pid,uptimeSeconds:Math.floor((Date.now()-Date.parse(this.startedAt))/1000),localComfy:this.localComfy,components:{core:this.core.snapshot(),admin:this.admin.snapshot(),...Object.fromEntries(Object.entries(this.components).map(([name,c])=>[name,Object.fromEntries(Object.entries(c).filter(([k])=>k!=='child'))]))},agent:{...agent,online},ready,workerState:ready?(this.localComfy.busy?'Busy':'Ready'):!this.localComfy.ready?'ComfyUI Offline':online?agent.state:agent?.state||'Agent Starting'};
  write(path.join(this.dir,'status.json'),state);
 }
 async run(){
  const lock=path.join(this.dir,'supervisor.lock'),old=read(lock);if(old&&alive(old.pid))throw Error(`Already running PID=${old.pid}`);if(old)fs.unlinkSync(lock);fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});
  this.log('worker','Supervisor started PID='+process.pid);this.rows=inventory();this.lastInventory=Date.now();
  const oldStatus=read(path.join(this.dir,'status.json'));
  for(const manager of [this.core,this.admin]){const key=manager.kind==='core'?this.config.workerKey:this.config.adminKey;const row=this.rows.find(p=>p.CommandLine?.includes(key)&&p.CommandLine?.includes(manager.kind==='core'?'-R':'-L'));const previous=oldStatus?.components[manager.kind];if(row&&previous?.target){manager.adopt(row,previous.target,previous);if(manager.kind==='admin')this.adminPort=previous.target.port}else if(row)throw Error('Untracked managed SSH process; refusing duplicate')}
  const priorAgent=this.rows.find(p=>p.CommandLine?.includes(path.join(this.dir,'worker-agent.cjs')));if(priorAgent)this.components.agent.pid=priorAgent.ProcessId;
  for(const port of [...new Set([...(this.config.comfyCandidates||[]).map(e=>e.port),8090,...this.config.adminPorts])])this.log('worker',`port ${port}: ${await available(port)?'available':'occupied/unavailable'}`);
  while(true){try{await this.tick()}catch(e){this.log('worker','monitor error: '+e.stack)}await new Promise(r=>setTimeout(r,2000))}
 }
}
module.exports={Supervisor,detectedEndpoints,urlFor};
if(require.main===module)new Supervisor(read(path.join(__dirname,'config.json')),__dirname).run().catch(e=>{console.error(e);process.exitCode=1});

