const {app,BrowserWindow,ipcMain,safeStorage}=require('electron');
const path=require('node:path'),os=require('node:os');
const {execFile}=require('node:child_process');
const fs=require('node:fs');
if(!app.requestSingleInstanceLock()){app.quit();process.exit(0)}
function recovery(){try{const s=JSON.parse(fs.readFileSync(path.join(require('./runtime-paths.cjs').dataDir(app.getPath('userData')),'status.json'),'utf8'));return {...s,fresh:Date.now()-Date.parse(s.updatedAt)<20000}}catch{return {fresh:false,components:{},agent:{state:'Not configured'}}}}
let previous;
const command=(file,args)=>new Promise(resolve=>execFile(file,args,{windowsHide:true,timeout:6000},(e,s)=>resolve(e?null:s.trim())));
async function json(url){try{const r=await fetch(url,{signal:AbortSignal.timeout(4000)});if(!r.ok)return null;return await r.json()}catch{return null}}
async function probe(){
 const managed=recovery();
 const adminPort=managed.fresh?managed.components.admin?.target?.port:null;
 const comfyUrl=managed.fresh&&managed.localComfy?.ready?managed.localComfy.url:null;
 const [gateway,comfy,queue,ssh,gpu]=await Promise.all([
 adminPort?json(`http://127.0.0.1:${adminPort}/health`):null,comfyUrl?json(comfyUrl+'/system_stats'):null,comfyUrl?json(comfyUrl+'/queue'):null,
 Promise.resolve(managed.fresh&&managed.components.core?.state==='Online'),
 command('nvidia-smi',['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu','--format=csv,noheader,nounits'])]);
 const now=os.cpus().reduce((a,c)=>({idle:a.idle+c.times.idle,total:a.total+Object.values(c.times).reduce((x,y)=>x+y,0)}),{idle:0,total:0});
 const cpu=previous&&now.total>previous.total?Math.round(100*(1-(now.idle-previous.idle)/(now.total-previous.total))):null;previous=now;
 return {scheduler:!!gateway,comfyui:!!comfy?.system,gateway,comfy,queue,ssh,managed,adminPort,gpu,cpu,memory:{used:((os.totalmem()-os.freemem())/2**30).toFixed(1),total:(os.totalmem()/2**30).toFixed(1)}};
}
let account;
const mainUrl=require('node:url').pathToFileURL(path.join(__dirname,'index.html')).href;
ipcMain.handle('worker:probe',async event=>{
 if(event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==mainUrl)throw Error('来源无效');
 await account.requireUser();
 let enrollmentError=null;
 try{await require('./recovery/enrollment.cjs').ensure(account,app)}catch(e){enrollmentError=e.message}
 const result=await probe();result.enrollmentError=enrollmentError;return result;
});
function create(){const w=new BrowserWindow({width:1280,height:820,minWidth:980,minHeight:650,backgroundColor:'#f5f7fb',autoHideMenuBar:true,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'preload.cjs')}});w.loadFile(path.join(__dirname,'index.html'));return w}
app.whenReady().then(()=>{account=require('./account.cjs').register({app,ipcMain,safeStorage},'worker',mainUrl);const win=create();require('./updater.cjs').register({app,ipcMain,win,mainUrl,onState:state=>require('./worker-version.cjs').writeSnapshot(require('./runtime-paths.cjs').dataDir(app.getPath('userData')),state)})});app.on('window-all-closed',()=>app.quit());
