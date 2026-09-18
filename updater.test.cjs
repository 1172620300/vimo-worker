const{test}=require('node:test');const assert=require('node:assert/strict');const{EventEmitter}=require('node:events');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const{register}=require('./updater.cjs');
function setup(packaged=true){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vimo-worker-updater-')),win=new EventEmitter(),wc=new EventEmitter();wc.send=()=>{};win.webContents=wc;win.isDestroyed=()=>false;const frame={url:'file:///worker/index.html'};wc.mainFrame=frame;const handlers={},updater=new EventEmitter();updater.checkForUpdates=async()=>updater.emit('update-available',{version:'0.1.2',releaseNotes:'修复连接问题'});updater.downloadUpdate=async()=>updater.emit('update-downloaded');let installs=0;updater.quitAndInstall=()=>installs++;const service=register({app:{isPackaged:packaged,getVersion:()=>'0.1.0',getPath:()=>dir},ipcMain:{handle:(key,fn)=>handlers[key]=fn},win,mainUrl:frame.url,verifyDownload:async()=>{},canInstall:()=>true},updater);return{call:a=>handlers['updater:'+a]({sender:wc,senderFrame:frame}),handlers,updater,service,installs:()=>installs,close:()=>fs.rmSync(dir,{recursive:true,force:true})}}
test('开发环境禁用更新',async()=>{const t=setup(false);try{await t.call('check');assert.equal(t.service.getState().status,'disabled')}finally{t.close()}});
test('用户明确选择后才下载和安装',async()=>{const t=setup();try{await t.call('check');assert.equal(t.service.getState().status,'available');assert.equal(t.updater.autoDownload,false);assert.equal(t.installs(),0);await t.call('download');assert.equal(t.service.getState().status,'downloaded');await t.call('install');await new Promise(setImmediate);assert.equal(t.installs(),1)}finally{t.close()}});
test('IPC 只接受主窗口',()=>{const t=setup();try{assert.throws(()=>t.handlers['updater:install']({sender:{},senderFrame:{url:'file:///worker/index.html'}}),/来源无效/)}finally{t.close()}});

test('checksum verification failure cannot install',async()=>{
 const t=setup();
 try {
  await t.call('check');
  t.updater.downloadUpdate=async()=>{t.updater.emit('update-downloaded');throw Error('checksum mismatch')};
  await t.call('download');
  assert.equal(t.service.getState().status,'error');
  await t.call('install');
  assert.equal(t.installs(),0);
 } finally {t.close()}
});

test('production defaults prohibit restarting without a maintenance gate',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vimo-install-gate-'));
 const win=new EventEmitter();win.isDestroyed=()=>false;win.webContents=new EventEmitter();win.webContents.send=()=>{};
 const frame={url:'file:///worker/index.html'};win.webContents.mainFrame=frame;
 const handlers={},updater=new EventEmitter();let installs=0;
 updater.checkForUpdates=async()=>updater.emit('update-available',{version:'0.1.2'});
 updater.downloadUpdate=async()=>updater.emit('update-downloaded');updater.quitAndInstall=()=>installs++;
 register({app:{isPackaged:true,getVersion:()=>'0.1.0',getPath:()=>dir},ipcMain:{handle:(n,f)=>handlers[n]=f},win,mainUrl:frame.url,verifyDownload:async()=>{}},updater);
 const call=n=>handlers['updater:'+n]({sender:win.webContents,senderFrame:frame});
 try {await call('check');await call('download');const result=await call('install');assert.equal(installs,0);assert.match(result.message,/维护升级/)}
 finally {fs.rmSync(dir,{recursive:true,force:true})}
});
