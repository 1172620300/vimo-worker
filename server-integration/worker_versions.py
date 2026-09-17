"""Stable Worker release discovery. No credentials and no task policy changes."""
import asyncio
import re
import time
import httpx

VERSION = re.compile(r'^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')

def stable_version(value):
    return value if isinstance(value, str) and VERSION.fullmatch(value) else None

def version_fields(body, latest, checked_at=None):
    current = stable_version(body.get('workerVersion'))
    latest = stable_version(latest)
    available = (tuple(map(int, latest.split('.'))) > tuple(map(int, current.split('.')))
                 if current and latest else None)
    return {'workerVersion': current, 'latestVersion': latest, 'updateAvailable': available,
            'updateState': body.get('updateState') or 'unknown',
            'hostname': body.get('hostname') or None,
            'versionCheckedAt': checked_at,
            'reportedLatestVersion': stable_version(body.get('latestVersion'))}

class WorkerReleases:
    def __init__(self):
        self.latest = None
        self.checked_at = None
        self.retry_at = 0
        self.lock = asyncio.Lock()

    async def get(self):
        if time.monotonic() < self.retry_at:
            return self.latest
        async with self.lock:
            if time.monotonic() < self.retry_at:
                return self.latest
            self.retry_at = time.monotonic() + 900
            try:
                async with httpx.AsyncClient(timeout=4, trust_env=False, follow_redirects=False) as client:
                    response = await client.get('https://api.github.com/repos/1172620300/vimo-worker/releases/latest',
                                                headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Vimo-Worker-Version-Monitor'})
                if response.status_code == 404:
                    self.latest = None
                    self.checked_at = time.time()
                    return None
                response.raise_for_status()
                release = response.json()
                version = stable_version(str(release.get('tag_name', '')).removeprefix('v'))
                names = {a.get('name') for a in release.get('assets', [])}
                if not version or release.get('draft') or release.get('prerelease'):
                    return self.latest
                if not {f'Vimo-Worker-Setup-{version}.exe', 'latest.yml', 'SHA256SUMS.txt'} <= names:
                    return self.latest
                self.latest = version
                self.checked_at = time.time()
                self.retry_at = time.monotonic() + 21600
            except (httpx.HTTPError, ValueError, TypeError):
                pass  # Preserve last known version; never turn a GitHub outage into a heartbeat failure.
        return self.latest
