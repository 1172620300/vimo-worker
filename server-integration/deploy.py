"""Run as the authorized ECS operator from a staged patch directory."""
import ast
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import time
import httpx

BASE=Path('/opt/vimo/releases/20260916-admin')
STAGE=Path(__file__).resolve().parent
DB=Path('/opt/vimo/data/vimo-admin.sqlite3')
EXPECTED={'vimo_workers.py':'57f7bf8b7ad0e85f45d2de53ef9eeedf679800d0031a3bc1e73a06e274cfb0cd',
          'admin-static/app.js':'dab35284d29fad303dffc1246a0bc34bcc20c322101f407c21cb877e85491b73'}
FILES=[*EXPECTED,'worker_versions.py']

def original_unchanged():
    for name,expected in EXPECTED.items():
        if hashlib.sha256((BASE/name).read_bytes()).hexdigest()!=expected:
            raise RuntimeError('Source changed since audit: '+name)
    if (BASE/'worker_versions.py').exists():raise RuntimeError('New module already exists; review before retry')

def cookie_name():
    tree=ast.parse((BASE/'vimo_admin.py').read_text())
    for node in tree.body:
        if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='COOKIE' for t in node.targets):
            return ast.literal_eval(node.value)
    raise RuntimeError('Cannot locate admin cookie configuration')

def main():
    if os.geteuid()!=0:raise RuntimeError('Requires the authorized root cloud-assistant session')
    original_unchanged()
    subprocess.run(['/opt/vimo/venv/bin/python','-m','unittest','-v','test_worker_versions.py'],cwd=STAGE,check=True)
    for name in ['worker_versions.py','vimo_workers.py']:
        compile((STAGE/name).read_text(),name,'exec')
    backup=Path('/opt/vimo/backups')/('release-versions-'+time.strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(mode=0o700)
    for name in EXPECTED:
        destination=backup/name;destination.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(BASE/name,destination)
    # Root is already authenticated through ECS. Use a short-lived local session to
    # invoke the existing audited pause/resume API without exposing any account password.
    token=secrets.token_urlsafe(48)
    digest=hashlib.sha256(token.encode()).hexdigest()
    with sqlite3.connect(DB) as db:
        db.execute('INSERT INTO sessions(hash,expires) VALUES(?,?)',(digest,time.time()+600))
    client=httpx.Client(base_url='http://127.0.0.1:18090',timeout=20,trust_env=False,
                        cookies={cookie_name():token},headers={'x-vimo-admin':'1'})
    original_paused=None;changed=False;success=False
    def api(path,method='GET',body=None):
        response=client.request(method,'/vimo-admin/api'+path,json=body)
        response.raise_for_status();return response.json()
    def wait_ready():
        for _ in range(30):
            try:
                health=client.get('/health');health.raise_for_status()
                if health.json().get('status')=='ok':return
            except httpx.HTTPError:pass
            time.sleep(1)
        raise RuntimeError('Gateway health did not recover')
    try:
        before=api('/snapshot');original_paused=bool(before['worker']['paused'])
        api('/worker','POST',{'enabled':False})
        for _ in range(30):
            snapshot=api('/snapshot')
            if snapshot['counts'].get('running',0)==0:break
            time.sleep(1)
        else:raise RuntimeError('Tasks still running; maintenance cancelled without stopping them')
        time.sleep(1)
        if api('/snapshot')['counts'].get('running',0):raise RuntimeError('A task is still running')
        original_unchanged()
        for name in FILES:
            target=BASE/name;temporary=target.with_name(target.name+'.release-version-tmp')
            shutil.copyfile(STAGE/name,temporary);temporary.chmod(0o644)
            changed=True;temporary.replace(target)
        subprocess.run(['systemctl','restart','vimo-gateway'],check=True,timeout=40)
        wait_ready()
        workers=api('/workers')
        if any('workerVersion' not in row or 'updateAvailable' not in row for row in workers):
            raise RuntimeError('New Worker fields missing')
        schema=client.get('/openapi.json').json()['components']['schemas']['Heartbeat']['properties']
        if not {'workerVersion','latestVersion','updateAvailable'}<=schema.keys():
            raise RuntimeError('Heartbeat schema not updated')
        health=client.get('/health').json()
        success=True
        print(json.dumps({'deployed':True,'backup':str(backup),'health':health.get('status'),
                          'workers':[{k:w.get(k) for k in ('worker_id','workerVersion','latestVersion','updateAvailable')} for w in workers]}))
    except BaseException:
        if changed:
            for name in EXPECTED:shutil.copy2(backup/name,BASE/name)
            (BASE/'worker_versions.py').unlink(missing_ok=True)
            subprocess.run(['systemctl','restart','vimo-gateway'],check=True,timeout=40)
            wait_ready()
            print('Rolled back application files')
        raise
    finally:
        try:
            if original_paused is not None:
                api('/worker','POST',{'enabled':not original_paused})
                print(json.dumps({'original_pause_state_restored':True,'paused':original_paused,'deployment_succeeded':success}))
        finally:
            with sqlite3.connect(DB) as db:db.execute('DELETE FROM sessions WHERE hash=?',(digest,))
            client.close()

if __name__=='__main__':main()
