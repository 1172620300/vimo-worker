(()=>{
 const worker=!!window.workerRuntime;
 const poolName=worker?'Vimo Worker':'Vimo Desktop';
 const style=document.createElement('link');
 style.rel='stylesheet';style.href='account.css';document.head.append(style);
 if(!worker)document.querySelector('#login').hidden=true;
 const overlay=document.createElement('section');overlay.className='account-overlay';
 overlay.innerHTML='<div class="account-panel"><h1>'+poolName+'</h1><p>使用'+(worker?'算力端':'创作端')+'独立账号登录</p><form><label>账号<input name="username" autocomplete="username" required minlength="3" maxlength="40"></label><label>密码<input name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="200"></label><label><input name="remember" type="checkbox" checked> 记住登录（7天）</label><button>登录</button><div class="account-message" role="alert"></div></form><p>账号由管理员创建</p></div>';
 document.body.append(overlay);
 const bar=document.createElement('div');bar.className='account-bar';bar.hidden=true;document.body.append(bar);
 const form=overlay.querySelector('form'),message=overlay.querySelector('.account-message');
 function lock(){window.vimoSignedIn=false;overlay.hidden=false;overlay.style.display='grid';bar.hidden=true;for(const child of document.body.children)if(child!==overlay&&child!==bar)child.inert=true;}
 function unlock(user){
  window.vimoSignedIn=true;for(const child of document.body.children)child.inert=false;overlay.style.display='none';bar.hidden=false;bar.replaceChildren(document.createTextNode(user.username+' · '+poolName));
  const button=document.createElement('button');button.textContent='退出登录';button.onclick=signout;bar.append(button);
  if(!worker){
   document.querySelector('#login').hidden=true;document.querySelector('#workspace').hidden=false;
   const iframe=document.querySelector('#live-canvas');iframe.src='canvas-app/index.html?account='+encodeURIComponent(user.id);
  }else window.dispatchEvent(new Event('account-ready'));
 }
 async function signout(){
  lock();if(!worker){document.querySelector('#live-canvas').src='about:blank';document.querySelector('#workspace').hidden=true;}
  try{await window.vimoAccount.logout();message.textContent='';}catch{message.textContent='本机已退出；服务器会话暂未撤销，将在到期后失效。';}
 }
 form.onsubmit=async e=>{
  e.preventDefault();form.querySelector('button').disabled=true;message.textContent='正在登录…';
  try{const user=await window.vimoAccount.login({username:form.elements.username.value.trim(),password:form.elements.password.value,remember:form.elements.remember.checked});form.elements.password.value='';message.textContent='';unlock(user);}catch(e){message.textContent=e.message.replace(/^Error invoking remote method.*?Error: /,'');}finally{form.querySelector('button').disabled=false;}
 };
 document.querySelector('#logout')?.addEventListener('click',signout);
 lock();window.vimoAccount.status().then(user=>{if(user)unlock(user)}).catch(()=>{message.textContent='无法恢复登录，请重新登录或检查网络。'});
 setInterval(async()=>{if(!window.vimoSignedIn)return;try{await window.vimoAccount.status();}catch{lock();message.textContent='登录验证失败，请重新登录。';if(!worker)document.querySelector('#live-canvas').src='about:blank';}},60000);
})();
