import unittest
from unittest.mock import AsyncMock, patch
from worker_versions import WorkerReleases, version_fields
from vimo_workers import Heartbeat

class VersionTests(unittest.IsolatedAsyncioTestCase):
    async def test_heartbeat_persists_versions_and_old_payload_still_works(self):
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from vimo_workers import Workers
        with tempfile.TemporaryDirectory() as directory:
            g=SimpleNamespace(OUTPUT=Path(directory),app=FastAPI(),admin=SimpleNamespace(query=lambda *args:True))
            workers=Workers(g)
            with workers.db() as db:
                db.execute('INSERT INTO workers(id,account_id,public_key,token_hash,tunnel_port) VALUES(?,?,?,?,?)',('test-worker','test-account','test-public-key','test-hash',19999))
            def authorize(request):
                with workers.db() as db:return dict(db.execute('SELECT * FROM workers WHERE id=?',('test-worker',)).fetchone())
            workers.authorize=authorize
            workers.probe=AsyncMock(return_value={'tunnel_online':True,'comfy_ready':True,'gpu_ready':True,'error':None})
            workers.releases.get=AsyncMock(return_value='0.2.0')
            with TestClient(g.app) as client:
                response=client.post('/v1/workers/heartbeat',json={'workerVersion':'0.1.0','tunnel_connected':True})
                self.assertEqual(response.status_code,200)
                self.assertTrue(response.json()['updateAvailable'])
                self.assertTrue(response.json()['ready'])
                with workers.db() as db:
                    import json
                    body=json.loads(db.execute('SELECT body FROM workers').fetchone()[0])
                    self.assertEqual(body['workerVersion'],'0.1.0')
                response=client.post('/v1/workers/heartbeat',json={'tunnel_connected':True})
                self.assertEqual(response.status_code,200)
                self.assertIsNone(response.json()['workerVersion'])

    def test_legacy_heartbeat(self):
        body = Heartbeat(comfy_ready=True).model_dump()
        self.assertIsNone(body['workerVersion'])
        self.assertIsNone(version_fields(body, '0.1.0')['updateAvailable'])

    def test_numeric_compare_and_untrusted_latest(self):
        body = Heartbeat(workerVersion='0.9.9', latestVersion='99.0.0', updateAvailable=False).model_dump()
        result = version_fields(body, '0.10.0')
        self.assertTrue(result['updateAvailable'])
        self.assertEqual(result['latestVersion'], '0.10.0')
        self.assertIsNone(version_fields(body, None)['updateAvailable'])
        self.assertFalse(version_fields({'workerVersion':'1.0.0'},'0.9.0')['updateAvailable'])

    async def test_github_outage_keeps_last_version_and_caches_failure(self):
        import httpx
        cache=WorkerReleases()
        cache.latest='0.1.0'
        with patch('httpx.AsyncClient.get',new=AsyncMock(side_effect=httpx.ConnectError('offline'))) as get:
            self.assertEqual(await cache.get(),'0.1.0')
            self.assertEqual(await cache.get(),'0.1.0')
            self.assertEqual(get.await_count,1)

    async def test_incomplete_release_not_offered(self):
        import httpx
        response=httpx.Response(200,json={'tag_name':'v0.2.0','assets':[]},request=httpx.Request('GET','https://api.github.com'))
        with patch('httpx.AsyncClient.get',new=AsyncMock(return_value=response)):
            self.assertIsNone(await WorkerReleases().get())

if __name__=='__main__':unittest.main()
