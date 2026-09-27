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
import re
import socketserver
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIMEOUT = 75  # seconds; the bridge's own merge_timeout is 60 and includes queue time
# Only what the game uses is proxied (the proxy adds the key, so everything else on the
# bridge, like /db/* or /generate, stays unreachable). Paths are checked after URL-decoding,
# so /merge/%72eset can't slip past as /merge/reset.
ALLOWED = [('GET', re.compile(r'/health')), ('POST', re.compile(r'/merge')),
           ('GET', re.compile(r'/merge/recipes')), ('GET', re.compile(r'/merge/items/[A-Za-z0-9_.:\-]{1,128}'))]


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
        if args and '/bridge/' in str(args[0]):  # args[0] is an HTTPStatus for error lines
            sys.stderr.write('[bridge] ' + (fmt % args) + '\n')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _foreign(self):
        # Only the game page itself may use the proxy: another website (CSRF) or a DNS-rebound
        # host name would otherwise get requests sent with the key added.
        port = self.server.server_address[1]
        own = {f'127.0.0.1:{port}', f'localhost:{port}'}
        origin = self.headers.get('Origin')
        return (self.headers.get('Host') not in own or (origin is not None and origin not in {'http://' + h for h in own})
                or self.headers.get('Sec-Fetch-Site') in ('cross-site', 'same-site'))

    def _proxy(self, method):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else None
        parts = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parts.path)[len('/bridge'):] or '/'
        if self._foreign():
            return self._reply(403, {'detail': 'The game proxy only accepts requests from the game page itself.', 'retryable': False})
        if '/merge/reset' in path:
            # /merge/reset is dev-only and never proxied from the game.
            return self._reply(403, {'detail': 'merge/reset is dev-only and disabled through the game proxy', 'retryable': False})
        if not any(m == method and rx.fullmatch(path) for m, rx in ALLOWED):
            return self._reply(403, {'detail': f'{method} {path} is not exposed through the game proxy', 'retryable': False})
        if parts.query:
            path += '?' + parts.query
        req = urllib.request.Request(self.bridge.rstrip('/') + path, data=body, method=method)
        req.add_header('Content-Type', 'application/json')
        if self.key:
            req.add_header('X-API-Key', self.key)
        ctype = 'application/json'
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                status, data, ctype = res.status, res.read(), res.headers.get('Content-Type', ctype)
        except urllib.error.HTTPError as e:  # bridge answered with an error: pass status and body through
            status, data, ctype = e.code, e.read(), e.headers.get('Content-Type', ctype)
        except (TimeoutError, urllib.error.URLError, OSError) as e:
            if isinstance(e, TimeoutError) or isinstance(getattr(e, 'reason', None), TimeoutError):
                # the bridge is up but slow: retryable, not "bridge down"
                status = 504
                data = json.dumps({'detail': f'FriedrichBridge did not answer within {TIMEOUT} s.', 'retryable': True}).encode()
            else:
                status = 503
                data = json.dumps({'detail': f'FriedrichBridge is not reachable at {self.bridge} ({e}). Run start_bridge.bat.', 'retryable': False, 'bridge_down': True}).encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/bridge/'):
            return self._proxy('GET')
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/bridge/'):
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
