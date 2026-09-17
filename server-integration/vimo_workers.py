"""Worker enrollment, durable unique reverse ports and server-side readiness."""
import asyncio, hashlib, json, os, re, secrets, socket, sqlite3, time
from pathlib import Path
import httpx
from contextlib import contextmanager
from fastapi import HTTPException, Request
from pydantic import BaseModel, Field
from worker_versions import WorkerReleases, version_fields

class Enrollment(BaseModel):
    installation_id: str = Field(pattern=r'^[a-f0-9-]{36}$')
    public_key: str = Field(min_length=60, max_length=200)

class Heartbeat(BaseModel):
    workerVersion: str | None = Field(default=None, max_length=40, pattern=r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
    latestVersion: str | None = Field(default=None, max_length=40, pattern=r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
    updateAvailable: bool | None = None
    updateState: str = Field(default='unknown', max_length=40)
    hostname: str = Field(default='', max_length=80)
    comfy_ready: bool = False
    tunnel_connected: bool = False
    gpu_ready: bool = False
    busy: bool = False
    local_url: str = Field(default='', max_length=160)
    last_error: str | None = Field(default=None, max_length=1000)

def digest(value): return hashlib.sha256(value.encode()).hexdigest()
def port_free(port):
    with socket.socket() as s:
        try: s.bind(('127.0.0.1', port)); return True
        except OSError: return False

class Workers:
    def __init__(self, g):
        self.g = g
        self.db_path = g.OUTPUT / 'worker-tunnels.sqlite3'
        self.keys_path = g.OUTPUT / 'worker-authorized-keys'
        self.first = int(os.getenv('WORKER_PORT_START', '18188'))
        self.last = int(os.getenv('WORKER_PORT_END', '18287'))
        self.probes = {}
        self.releases = WorkerReleases()
        with self.db() as c:
            c.executescript('''CREATE TABLE IF NOT EXISTS workers(
              id TEXT PRIMARY KEY, account_id TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE,
              token_hash TEXT NOT NULL, tunnel_port INTEGER NOT NULL UNIQUE,
              generation INTEGER NOT NULL DEFAULT 1, allocated REAL NOT NULL DEFAULT 0,
              heartbeat REAL, body TEXT NOT NULL DEFAULT '{}');
              CREATE TABLE IF NOT EXISTS retired_ports(port INTEGER PRIMARY KEY, retired REAL NOT NULL);''')
        self.sync_keys()
        self.routes()

    @contextmanager
    def db(self):
        c = sqlite3.connect(self.db_path, timeout=15)
        c.row_factory = sqlite3.Row
        try:
            with c: yield c
        finally: c.close()

    def allowed(self, row):
        return self.g.admin.query('''SELECT a.id FROM client_accounts a JOIN account_devices d
          ON d.account_id=a.id WHERE a.id=? AND a.pool='worker' AND a.enabled=1
          AND d.installation_id=?''', (row['account_id'],row['id']), True)

    def authorize(self, request):
        token = request.headers.get('authorization','').removeprefix('Bearer ')
        with self.db() as c: row = c.execute('SELECT * FROM workers WHERE token_hash=?',(digest(token),)).fetchone()
        if row is None or not self.allowed(row): raise HTTPException(401, 'Worker enrollment revoked or missing')
        return dict(row)

    def allocate(self, c):
        for row in c.execute('SELECT port FROM retired_ports WHERE retired<?',(time.time()-600,)).fetchall():
            if port_free(row[0]):c.execute('DELETE FROM retired_ports WHERE port=?',(row[0],))
        used = {r[0] for r in c.execute('SELECT tunnel_port FROM workers')}
        used.update(r[0] for r in c.execute('SELECT port FROM retired_ports'))
        for port in range(self.first,self.last+1):
            if port not in used and port_free(port): return port
        raise HTTPException(503, 'No free tunnel ports; contact scheduler administrator')

    def sync_keys(self):
        # Per-key permitlisten is authoritative; no shared wildcard tunnel key.
        with self.db() as c: rows = list(c.execute('SELECT * FROM workers'))
        text = ''.join(f'restrict,port-forwarding,permitlisten="127.0.0.1:{r["tunnel_port"]}",command="/bin/false" {r["public_key"]}\n' for r in rows if self.allowed(r))
        temp = self.keys_path.with_suffix('.tmp')
        temp.write_text(text);temp.chmod(0o600);temp.replace(self.keys_path)

    def allocation(self,row):
        return {'worker_id':row['id'],'tunnel_port':row['tunnel_port'],'generation':row['generation'],
                'ssh_host':os.getenv('WORKER_SSH_HOST','47.98.134.75'),'ssh_port':22,'ssh_user':'vimo',
                'heartbeat_seconds':10,'heartbeat_ttl':35}

    async def probe(self,row):
        now=time.time(); cached=self.probes.get(row['id'])
        if cached and now-cached['checked_at']<3: return cached
        tunnel=False;comfy=False;gpu=False;error=None
        try:
            reader,writer=await asyncio.wait_for(asyncio.open_connection('127.0.0.1',row['tunnel_port']),2)
            tunnel=True;writer.close();await writer.wait_closed()
            async with httpx.AsyncClient(timeout=4,trust_env=False) as client:
                r=await client.get(f'http://127.0.0.1:{row["tunnel_port"]}/system_stats');r.raise_for_status();data=r.json()
                comfy=isinstance(data.get('system'),dict) and isinstance(data.get('devices'),list)
                gpu=comfy and any(d.get('type') in ('cuda','mps','xpu') for d in data['devices'])
        except Exception as e: error=type(e).__name__
        result=dict(checked_at=now,tunnel_online=tunnel,comfy_ready=comfy,gpu_ready=gpu,error=error)
        self.probes[row['id']]=result;return result

    async def status(self,row):
        proof=await self.probe(row);body=json.loads(row['body']);agent=bool(row['heartbeat'] and time.time()-row['heartbeat']<35 and self.allowed(row))
        ready=agent and proof['tunnel_online'] and proof['comfy_ready'] and proof['gpu_ready'] and body.get('tunnel_connected',False)
        state=('Offline' if not agent else 'Agent Online / Tunnel Offline' if not proof['tunnel_online'] else 'Tunnel Online / ComfyUI Offline' if not proof['comfy_ready'] else 'GPU Not Ready' if not proof['gpu_ready'] else 'Reconnecting' if not body.get('tunnel_connected') else 'Busy' if body.get('busy') else 'Ready')
        latest = await self.releases.get()
        return {**self.allocation(row),**proof,**version_fields(body,latest,self.releases.checked_at),'agent_online':agent,'ready':ready,'state':state,'last_heartbeat':row['heartbeat'],'last_error':body.get('last_error') or proof['error']}

    async def primary_status(self):
        with self.db() as c:row=c.execute('SELECT * FROM workers WHERE id=?',(os.getenv('WORKER_PRIMARY_ID',''),)).fetchone()
        if not row:return {'online':False,'state':'Enrollment required','checked_at':time.time(),'devices':[]}
        result=await self.status(dict(row))
        return {**result,'online':result['ready'],'devices':[]}

    def routes(self):
        app=self.g.app
        @app.post('/v1/workers/register')
        async def register(body:Enrollment,request:Request):
            account=self.g.accounts.authorize(request.headers.get('authorization'),'worker')
            key=body.public_key.strip()
            if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]{68}={0,2}',key): raise HTTPException(400,'Expected an ed25519 public key without comment')
            bound=self.g.admin.query('SELECT account_id FROM account_devices WHERE installation_id=?',(body.installation_id,),True)
            if not bound or bound['account_id']!=account['id']:raise HTTPException(403,'Bind this device to the Worker account first')
            token=secrets.token_urlsafe(48)
            with self.db() as c:
                c.execute('BEGIN IMMEDIATE')
                old=c.execute('SELECT * FROM workers WHERE id=?',(body.installation_id,)).fetchone()
                if old and old['account_id']!=account['id']:raise HTTPException(409,'Worker belongs to another account')
                if old and old['public_key']!=key:raise HTTPException(409,'Device key changed; administrator must re-enroll it')
                if old:c.execute('UPDATE workers SET token_hash=? WHERE id=?',(digest(token),body.installation_id))
                else:
                    port=self.allocate(c)
                    try:c.execute('INSERT INTO workers(id,account_id,public_key,token_hash,tunnel_port,allocated) VALUES(?,?,?,?,?,?)',(body.installation_id,account['id'],key,digest(token),port,time.time()))
                    except sqlite3.IntegrityError:raise HTTPException(409,'SSH public key is already enrolled')
                row=dict(c.execute('SELECT * FROM workers WHERE id=?',(body.installation_id,)).fetchone())
            self.sync_keys()
            return {**self.allocation(row),'device_token':token}

        @app.post('/v1/workers/heartbeat')
        async def heartbeat(body:Heartbeat,request:Request):
            row=self.authorize(request)
            row.update(heartbeat=time.time(),body=json.dumps(body.model_dump()))
            with self.db() as c:c.execute('UPDATE workers SET heartbeat=?,body=? WHERE id=?',(row['heartbeat'],row['body'],row['id']))
            if row['id']==os.getenv('WORKER_PRIMARY_ID'):
                self.g.COMFY=f'http://127.0.0.1:{row["tunnel_port"]}'
            return await self.status(row)

        @app.post('/v1/workers/reallocate')
        async def reallocate(request:Request):
            row=self.authorize(request)
            # Do not kill an unrelated listener. Move this Worker to a fresh reservation instead.
            if json.loads(row['body']).get('tunnel_connected'):raise HTTPException(409,'Stop the current tunnel before requesting another port')
            if time.time()-row['allocated']<60:raise HTTPException(429,'Wait before requesting another port')
            with self.db() as c:
                c.execute('BEGIN IMMEDIATE')
                current=c.execute('SELECT * FROM workers WHERE id=?',(row['id'],)).fetchone()
                if current['generation']!=row['generation']:raise HTTPException(409,'Allocation changed; refresh heartbeat')
                port=self.allocate(c)
                c.execute('INSERT OR REPLACE INTO retired_ports VALUES(?,?)',(row['tunnel_port'],time.time()))
                c.execute('UPDATE workers SET tunnel_port=?,generation=generation+1,allocated=? WHERE id=?',(port,time.time(),row['id']))
                row=dict(c.execute('SELECT * FROM workers WHERE id=?',(row['id'],)).fetchone())
            self.sync_keys();self.probes.pop(row['id'],None)
            return self.allocation(row)

        @app.get('/vimo-admin/api/workers')
        async def list_workers():
            with self.db() as c:rows=[dict(r) for r in c.execute('SELECT * FROM workers')]
            return await asyncio.gather(*(self.status(r) for r in rows))
