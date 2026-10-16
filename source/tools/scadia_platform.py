"""Authenticated analytics client with bounded retries and no credential logging."""
import json
import time
import urllib.request
from urllib.error import HTTPError, URLError


class Platform:
    def __init__(self, cfg, log=lambda message: None):
        self.base = str(cfg.get('platform') or 'http://127.0.0.1:1881').rstrip('/')
        self.user = cfg.get('user') or 'admin'
        self.password = cfg.get('password') or ''
        self.token = None
        self.next_login = 0
        self.next_push = 0
        self.delivery = {'status': 'not_sent'}
        self.log = log

    def _http(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['x-access-token'] = self.token
        request = urllib.request.Request(self.base + path, data=data, headers=headers)
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    def signin_throttled(self):
        if time.monotonic() < self.next_login:
            return False
        self.next_login = time.monotonic() + 30
        try:
            self.token = (self._http('/api/signin', {'username': self.user, 'password': self.password}).get('data') or {}).get('token')
        except (HTTPError, URLError, OSError, ValueError):
            self.token = None
        return bool(self.token)

    def signin(self):
        return self.signin_throttled()

    def request(self, path, body=None):
        if not self.token and not self.signin_throttled():
            raise OSError('LOGIN_UNAVAILABLE')
        for attempt in range(2):
            try:
                return self._http(path, body)
            except HTTPError as error:
                if error.code == 401 and attempt == 0:
                    self.token = None
                    if self.signin_throttled():
                        continue
                raise

    def send(self, payload):
        if time.monotonic() < self.next_push:
            return None, 'backoff'
        at = int(time.time() * 1000)
        try:
            value = self.request('/api/ai/events', payload)
            self.delivery = {'status': 'delivered', 'lastSuccessAt': at, 'httpStatus': 200}
            return 200, value
        except HTTPError as error:
            try:
                code = json.loads(error.read(4096)).get('error', 'HTTP_ERROR')
                if not isinstance(code, str) or not code.replace('_', '').isalnum():
                    code = 'HTTP_ERROR'
            except (ValueError, OSError):
                code = 'HTTP_ERROR'
            self.next_push = time.monotonic() + (300 if error.code == 403 else 30 if error.code == 429 else 10)
            self.delivery = dict(self.delivery, status='rejected', lastFailureAt=at, httpStatus=error.code, errorCode=code)
            return error.code, code
        except (OSError, ValueError):
            self.next_push = time.monotonic() + 10
            self.delivery = dict(self.delivery, status='unavailable', lastFailureAt=at, errorCode='PLATFORM_UNAVAILABLE')
            return None, 'PLATFORM_UNAVAILABLE'
