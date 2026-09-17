const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const BASE='https://imaideo.xyz/vimo-api/v1';
function register({app,ipcMain,safeStorage},pool,mainUrl){
 const file=path.join(app.getPath('userData'),pool+'-session.bin');
 const deviceFile=path.join(app.getPath('userData'),'worker-installation-id');
 let token='',user=null;
 try{if(fs.existsSync(file)&&safeStorage.isEncryptionAvailable())token=safeStorage.decryptString(fs.readFileSync(file));}catch{}
 async function request(route,body,credential=token){
  const r=await fetch(BASE+'/auth/'+pool+route,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',...(credential?{Authorization:'Bearer '+credential}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(typeof data.detail==='string'?data.detail:'账号请求失败 ('+r.status+')');return data;
 }
 function clear(){token='';user=null;fs.rmSync(file,{force:true});}
 async function requireUser(){if(!token)throw Error('请先登录');user=await request('/me');return user;}
 async function login(input){
  if(!input||typeof input.username!=='string'||typeof input.password!=='string')throw Error('请输入账号密码');
  if(input.remember&&!safeStorage.isEncryptionAvailable())throw Error('系统安全存储不可用，请取消记住登录');
  const data=await request('/login',{username:input.username,password:input.password},'');
  try{
   if(pool==='worker'){
    fs.mkdirSync(path.dirname(deviceFile),{recursive:true});
    let installation=fs.existsSync(deviceFile)?fs.readFileSync(deviceFile,'utf8'):crypto.randomUUID();
    if(!fs.existsSync(deviceFile))fs.writeFileSync(deviceFile,installation,{flag:'wx'});
    await request('/device',{installation_id:installation,name:os.hostname().slice(0,80)},data.token);
   }
  }catch(e){await request('/logout',{},data.token).catch(()=>{});throw e;}
  token=data.token;user=data.user;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(input.remember)fs.writeFileSync(file,safeStorage.encryptString(token));else fs.rmSync(file,{force:true});
  return user;
 }
 async function logout(){try{if(token)await request('/logout',{});}finally{clear();}}
 for(const [name,fn] of Object.entries({login,logout,status:async()=>token?requireUser():null})){
  ipcMain.handle('account:'+name,(event,input)=>{
   if(event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==mainUrl)throw Error('来源无效');
   return fn(input);
  });
 }
 return {requireUser,credentials:()=>({protocol:'custom',baseUrl:BASE,model:'H3',apiKey:token}),current:()=>user};
}
module.exports={register};
