const fs=require('node:fs');
const path=require('node:path');
const semver=require('semver');

function register({app,ipcMain,win,mainUrl},injected){
 const updater=injected||require('electron-updater').autoUpdater;
 const enabled=app.isPackaged&&process.platform==='win32';
 let state={status:enabled?'idle':'disabled',currentVersion:app.getVersion(),enabled,progress:null,message:enabled?'':'开发环境不检查更新。'},busy=false;
 const logFile=path.join(app.getPath('userData'),'updater.log');
 function log(message){try{if(fs.existsSync(logFile)&&fs.statSync(logFile).size>1024*1024)fs.renameSync(logFile,logFile+'.1');fs.appendFileSync(logFile,`${new Date().toISOString()} [Updater] ${message}\n`)}catch{}}
 updater.logger={info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}};
 updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowPrerelease=false;updater.allowDowngrade=false;
 function emit(patch){state={...state,...patch};if(!win.isDestroyed())win.webContents.send('updater:state',state)}
 function fail(){log('Update operation failed');emit({status:'error',message:'暂时无法检查或下载更新，请检查网络后重试。'})}
 updater.on('error',fail);
 updater.on('checking-for-update',()=>{log('Checking for update');emit({status:'checking',message:'正在检查更新…'})});
 updater.on('update-not-available',()=>emit({status:'current',message:'当前已是最新版本。',latestVersion:null,notes:''}));
 updater.on('update-available',info=>{const version=semver.valid(info.version);log(`Latest version: ${version||'invalid'}`);const notes=Array.isArray(info.releaseNotes)?info.releaseNotes.map(n=>n.note||'').join('\n'):String(info.releaseNotes||'暂无更新说明');emit({status:'available',latestVersion:version||info.version,notes:notes.slice(0,50000),message:''})});
 let lastPercent=-1,downloadToken;
 updater.on('download-progress',p=>{const percent=Math.floor(p.percent);if(percent!==lastPercent){lastPercent=percent;log(`Download progress: ${percent}%`)}emit({status:'downloading',progress:{percent:p.percent,transferred:p.transferred,total:p.total,bytesPerSecond:p.bytesPerSecond}})});
 updater.on('update-downloaded',()=>{log('Update downloaded');emit({status:'downloaded',message:'更新已下载，可以重启安装。',progress:null})});
 updater.on('update-cancelled',()=>emit({status:'available',progress:null,message:'已取消下载，可以稍后重试。'}));
 async function check(){if(!enabled||busy||['downloaded','downloading'].includes(state.status))return state;busy=true;try{await updater.checkForUpdates()}catch{fail()}finally{busy=false}return state}
 async function download(){if(!enabled||busy||!state.latestVersion||!['available','error'].includes(state.status))return state;busy=true;lastPercent=-1;emit({status:'downloading',message:'',progress:null});log('Downloading update');try{downloadToken=new(require('builder-util-runtime').CancellationToken)();await updater.downloadUpdate(downloadToken)}catch{if(downloadToken?.cancelled)emit({status:'available',message:'已取消下载，可以稍后重试。'});else fail()}finally{busy=false}return state}
 const actions={state:()=>state,check,download,cancel:()=>{downloadToken?.cancel();return state},install:()=>{if(enabled&&state.status==='downloaded'){log('Installing update');setImmediate(()=>updater.quitAndInstall(false,true))}return state}};
 for(const[action,handler]of Object.entries(actions))ipcMain.handle('updater:'+action,event=>{if(event.sender!==win.webContents||event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==mainUrl)throw Error('来源无效');return handler()});
 log(`Current version: ${app.getVersion()}`);
 let timer;win.webContents.once('did-finish-load',()=>{if(enabled)timer=setTimeout(check,5000)});win.on('closed',()=>clearTimeout(timer));
 return{getState:()=>state};
}
module.exports={register};
