"""Local origin and authenticated proxy fixtures. No requests leave this process."""
import base64
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.server.label != 'direct':
            expected = 'Basic ' + base64.b64encode((self.server.label + ':fixture').encode()).decode()
            if self.headers.get('Proxy-Authorization') != expected:
                self.send_response(407)
                self.send_header('Proxy-Authenticate', 'Basic realm="fixture"')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
        path = urlsplit(self.path).path
        if path == '/token':
            body = json.dumps({'c': self.server.label}).encode()
        else:
            body = b'''<!doctype html><script>
              const before = {cookie: document.cookie, storage: localStorage.getItem('account'), agent: navigator.userAgent};
              document.cookie = 'account=fixture; Path=/'; localStorage.setItem('account', 'fixture');
              window.SentinelSDK = {init() {}, async token() {
                if (navigator.userAgent === 'fixture-hang') await new Promise(() => {});
                const data = await (await fetch('/token')).json();
                data.p = JSON.stringify(before); return JSON.stringify(data);
              }};
            </script>'''
        self.send_response(200)
        self.send_header('Content-Type', 'application/json' if path == '/token' else 'text/html')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


servers = []
for label in ['direct', 'proxy-one', 'proxy-two']:
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.label = label
    threading.Thread(target=server.serve_forever, daemon=True).start()
    servers.append(server)
print(json.dumps({server.label: server.server_port for server in servers}), flush=True)
try:
    sys.stdin.read()
finally:
    for server in servers:
        server.shutdown()
        server.server_close()
