'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const retryDelay=n=>[5000,10000,30000,60000][Math.min(Math.max(n-1,0),3)];
function sshArgs(config,kind,target,log){
 const args=['-F','NUL','-NT','-v','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ConnectionAttempts=1','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${config.knownHosts}`,'-i',kind==='core'?config.workerKey:config.adminKey,'-p',String(target.sshPort||22)];
 const host=target.host.includes(':')?`[${target.host}]`:target.host;
 return args.concat(kind==='core'?['-R',`127.0.0.1:${target.remotePort}:${host}:${target.port}`]:['-L',`127.0.0.1:${target.port}:127.0.0.1:${target.remotePort}`],target.server);
}
function available(port){return new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(()=>resolve(true)))})}
async function freePort(ports){for(const p of ports)if(await available(p))return p;return null}
function tcp(host,port){return new Promise(resolve=>{const s=net.connect({host,port});let finished=false;function done(ok){if(finished)return;finished=true;s.destroy();resolve(ok)}s.setTimeout(3000,()=>done(false));s.once('connect',()=>done(true));s.once('error',()=>done(false))})}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
class TunnelManager{
 constructor(kind,config,dir){this.kind=kind;this.config=config;this.dir=dir;this.logFile=path.join(dir,'logs',`ssh-${kind}.log`);this.transport=path.join(dir,'logs',`ssh-${kind}-transport.log`);this.state={state:'Waiting',pid:null,attempts:0,reconnects:0,failures:0,nextRetry:0,lastError:null,lastExitCode:null,lastSuccess:null};this.offset=0;this.partial='';}
 log(message){fs.appendFileSync(this.logFile,`${new Date().toISOString()} ${message}\n`)}
 stop(reason){this.log('stop: '+reason);if(this.child){const child=this.child;this.child=null;child.kill()}else if(this.state.pid&&alive(this.state.pid)){process.kill(this.state.pid)}this.state.pid=null;this.state.state='Waiting';this.confirmed=false;this.target=null}
 failure(message,code){this.confirmed=false;this.state.pid=null;this.state.state='Reconnecting';this.state.failures++;this.state.lastExitCode=code??null;this.state.lastError=String(message);this.state.nextRetry=Date.now()+retryDelay(this.state.failures);this.log(`${message}; exit=${code}; next retry=${retryDelay(this.state.failures)/1000}s`)}
 scan(){try{const size=fs.statSync(this.transport).size;if(size<=this.offset)return;const fd=fs.openSync(this.transport,'r'),b=Buffer.alloc(size-this.offset);try{fs.readSync(fd,b,0,b.length,this.offset)}finally{fs.closeSync(fd)}this.offset=size;const lines=(this.partial+b.toString()).split(/\r?\n/);this.partial=lines.pop();for(const line of lines){this.log(line);if(this.kind==='core'&&line.includes(`remote forward success for: listen 127.0.0.1:${this.target.remotePort}`)){this.confirmed=true;this.state.lastSuccess=new Date().toISOString();this.log(`Reverse port ${this.target.remotePort} established PID=${this.state.pid}`)}if(this.kind==='admin'&&line.includes(`Local forwarding listening on 127.0.0.1 port ${this.target.port}`))this.confirmed=true;if(/remote port forwarding failed|remote forward failure/.test(line))this.state.portConflict=true}}catch(e){if(e.code!=='ENOENT')this.log(e.message)}}
 adopt(row,target,previous){this.target=target;this.state={...this.state,...previous,pid:row.ProcessId,state:'Connecting'};this.confirmed=false;this.offset=0;this.log(`adopt PID=${row.ProcessId}`)}
 async tick(target){
  if(!target){if(this.state.pid)this.stop('target no longer available');this.state.state='Waiting for local health / registration';return}
  if(this.target&&JSON.stringify(this.target)!==JSON.stringify(target))this.stop('allocation or local endpoint changed');
  if(this.state.pid){if(!alive(this.state.pid)){this.failure('Process exited while supervisor was restarting',null);return}this.scan();this.state.state=this.confirmed?'Online':'Connecting';if(this.confirmed&&Date.now()-this.state.startedMs>120000)this.state.failures=0;return}
  if(Date.now()<this.state.nextRetry)return;
  if(!await tcp(target.server.split('@').pop(),target.sshPort||22)){this.failure('SSH server TCP connection unavailable',null);return}
  // Windows OpenSSH validates ACLs against the service identity, not the interactive login.
  const key=this.kind==='core'?this.config.workerKey:this.config.adminKey;
  if(!fs.existsSync(key)){this.failure('SSH key missing; enroll this Worker first',null);return}
  if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
   "$p=$env:VIMO_PRIVATE_KEY;$a=New-Object System.Security.AccessControl.FileSecurity;$a.SetAccessRuleProtection($true,$false);$s=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');$a.SetOwner($s);foreach($id in @('S-1-5-18','S-1-5-32-544')){$r=New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($id)),'FullControl','Allow');$a.AddAccessRule($r)};Set-Acl -LiteralPath $p -AclObject $a"],{windowsHide:true,timeout:10000,env:{...process.env,VIMO_PRIVATE_KEY:key}});
  this.target=target;this.confirmed=false;this.state.portConflict=false;this.offset=0;this.partial='';fs.writeFileSync(this.transport,'');
  this.state.attempts++;this.state.reconnects=Math.max(0,this.state.attempts-1);this.state.state='Connecting';this.state.startedMs=Date.now();this.state.startedAt=new Date().toISOString();
  const args=sshArgs(this.config,this.kind,target,this.transport);this.log(`start server=${target.server} remote=${target.remotePort} local=${target.host}:${target.port} attempt=${this.state.attempts}`);
  const child=spawn(this.config.ssh,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});this.child=child;this.state.pid=child.pid;this.log(`SSH PID=${child.pid}`);
  // OpenSSH on Windows locks -E files while connected. Own the log through stderr instead.
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{fs.appendFileSync(this.transport,b);this.scan()});
  child.once('error',e=>{this.spawnError=e.message});
  child.once('close',(code,signal)=>{if(this.child!==child)return;this.scan();this.child=null;this.failure(`SSH exited signal=${signal||''} ${this.spawnError||''}`,code)});
 }
 snapshot(){return {...this.state,target:this.target,confirmed:!!this.confirmed}}
}
module.exports={TunnelManager,sshArgs,retryDelay,available,freePort,tcp,alive};
