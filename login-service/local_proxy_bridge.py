import json
import os
import queue
import subprocess
import threading
from pathlib import Path
from urllib.parse import urlsplit, unquote


class BrowserProxyBridge:
    def __init__(self, url):
        self.process = subprocess.Popen(
            ['node', str(Path(__file__).parent / 'scripts' / 'browser-proxy.mjs')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        )
        try:
            self.process.stdin.write(json.dumps({'url': url}) + '\n')
            self.process.stdin.flush()
            result = queue.Queue()
            threading.Thread(target=lambda: result.put(self.process.stdout.readline()), daemon=True).start()
            self.server = json.loads(result.get(timeout=10))['server']
        except Exception:
            self.stop()
            raise RuntimeError('Browser proxy bridge could not start') from None

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for stream in (self.process.stdin, self.process.stdout):
            if stream:
                stream.close()


def playwright_proxy_via_bridge(value):
    parsed = urlsplit(value if '://' in value else 'http://' + value)
    if os.environ.get('PROXY_CHAIN_URL') or parsed.scheme in ('socks4', 'socks4a', 'socks5', 'socks5h'):
        bridge = BrowserProxyBridge(value)
        return {'server': bridge.server}, bridge
    if parsed.scheme not in ('http', 'https'):
        raise ValueError('Unsupported browser proxy protocol')
    host = '[' + parsed.hostname + ']' if ':' in parsed.hostname else parsed.hostname
    proxy = {'server': f'{parsed.scheme}://{host}:{parsed.port}'}
    if parsed.username:
        proxy.update(username=unquote(parsed.username), password=unquote(parsed.password or ''))
    return proxy, None
