#!/usr/bin/env python3
"""Serve Essence Protocol locally and proxy /bridge/* to FriedrichBridge.

The browser only ever talks to this server (same origin, so no CORS), and
the bridge API key stays on this machine: it is read from the
FRIEDRICH_BRIDGE_KEY environment variable, or from an untracked
bridge.local.json next to index.html. It is never sent to the browser.

    set FRIEDRICH_BRIDGE_KEY=...          (Windows)   export ... (macOS/Linux)
    python tools/serve.py                 -> http://127.0.0.1:8090

Options: --port 8090 (the game; not 8080, FriedrichAI uses it), --bridge http://127.0.0.1:8765 (FriedrichBridge).
The bridge port normally comes from C:\\Users\\<you>\\FriedrichBridge\\config.json.
"""
import argparse
import http.server
import json
import os
import socketserver
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMEOUT = 75  # seconds; the bridge's own merge_timeout is 60 and includes queue time


def load_local():
    path = os.path.join(ROOT, 'bridge.local.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    return {}


class Handler(http.server.SimpleHTTPRequestHandler):
    bridge = 'http://127.0.0.1:8765'
    key = ''

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if '/bridge/' in (args[0] if args else ''):
            sys.stderr.write('[bridge] ' + (fmt % args) + '\n')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _proxy(self, method):
        path = self.path[len('/bridge'):] or '/'
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(self.bridge.rstrip('/') + path, data=body, method=method)
        req.add_header('Content-Type', 'application/json')
        if self.key:
            req.add_header('X-API-Key', self.key)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                status, data = res.status, res.read()
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as e:
            status = 503
            data = json.dumps({'detail': f'FriedrichBridge is not reachable at {self.bridge} ({e}). Run start_bridge.bat.', 'retryable': False, 'bridge_down': True}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/bridge/'):
            return self._proxy('GET')
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/bridge/'):
            # /merge/reset is dev-only and never proxied from the game.
            if self.path.startswith('/bridge/merge/reset'):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                data = json.dumps({'detail': 'merge/reset is dev-only and disabled through the game proxy', 'retryable': False}).encode()
                self.send_response(403)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            return self._proxy('POST')
        self.send_error(405)


def main():
    local = load_local()
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--port', type=int, default=int(local.get('port', 8090)))
    ap.add_argument('--bridge', default=local.get('bridge_url', 'http://127.0.0.1:8765'))
    args = ap.parse_args()
    Handler.bridge = args.bridge
    Handler.key = os.environ.get('FRIEDRICH_BRIDGE_KEY') or local.get('key', '')
    if not Handler.key:
        print('warning: no bridge key (set FRIEDRICH_BRIDGE_KEY or bridge.local.json). Merges will fall back to baked text.')
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('127.0.0.1', args.port), Handler) as httpd:
        print(f'Essence Protocol on http://127.0.0.1:{args.port}  ->  bridge {args.bridge}')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
