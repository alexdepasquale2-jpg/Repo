#!/usr/bin/env python3
"""Serve Essence Protocol locally, with the content editor.

    python tools/serve.py                 -> http://127.0.0.1:8090 (the game)
                                             http://127.0.0.1:8090/editor/ (the content editor)
    python tools/serve.py --lan           -> also reachable from a phone on the same Wi-Fi

The game is fully static: every merge is pre-baked in db/ and nothing is generated live,
so this is mostly a file server. It gzips text (as a real host would), sends no-store so
edits show up on reload, and answers the retired FriedrichBridge proxy routes (/bridge/*)
with 410 Gone. Browsers only enable the service worker (offline play) on localhost or
HTTPS, so over --lan the game runs but does not install for offline use.

The content editor saves through a small API. It bakes in the browser with the game's own
code, so saving needs no Node.js; Node is only used by "Run the full checks".
    GET  /api/info    what this server can do
    GET  /api/data    data/*.json as one object, read fresh from disk
    PUT  /api/files   {"files": {path: text}} writes data/*.json, db/*.json and js/data.js only
    POST /api/check   runs tools/bake.js --check, tools/content.js check and tools/verify.js
Only this computer can write: requests from other devices (with --lan) are read-only.
"""
import argparse
import gzip
import http.server
import io
import json
import os
import re
import shutil
import socket
import socketserver
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GZIP_TYPES = ('text/', 'application/json', 'application/javascript', 'image/svg+xml', 'application/manifest+json')
DATA_FILES = ['essences', 'combos', 'battle', 'traits', 'items', 'words', 'world', 'overrides']  # js/schema.js FILES
WRITABLE = re.compile(r'^(data/(' + '|'.join(DATA_FILES) + r')\.json|db/[A-Z]{2}\.json|db/index\.json|js/data\.js)$')
MAX_BODY = 32 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'application/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _local_client(self):
        return self.client_address[0] in ('127.0.0.1', '::1', '::ffff:127.0.0.1')

    def _api_get(self, route):
        if route == 'info':
            return self._json(200, {'editor': True, 'node': bool(shutil.which('node')), 'writable': self._local_client()})
        if route == 'data':
            # the raw file texts, so numbers and key order stay exactly as written
            parts = []
            for name in DATA_FILES:
                with open(os.path.join(ROOT, 'data', name + '.json'), encoding='utf-8') as f:
                    parts.append(json.dumps(name) + ':' + f.read().strip())
            data = ('{' + ','.join(parts) + '}').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return self._json(404, {'error': 'unknown api ' + route})

    def _read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError('the request body is empty or too big')
        return json.loads(self.rfile.read(n).decode('utf-8'))

    def _api_write(self, method, route):
        if not self._local_client():
            return self._json(403, {'error': 'only this computer can save; other devices can look but not write'})
        if method == 'PUT' and route == 'files':
            try:
                files = self._read_json().get('files') or {}
            except (ValueError, json.JSONDecodeError) as e:
                return self._json(400, {'error': str(e)})
            bad = [p for p, t in files.items() if not isinstance(p, str) or not WRITABLE.match(p) or not isinstance(t, str)]
            if bad:
                return self._json(400, {'error': 'not allowed to write ' + ', '.join(map(str, bad[:5]))})
            for p, t in files.items():
                if p.endswith('.json'):
                    try:
                        json.loads(t)
                    except json.JSONDecodeError as e:
                        return self._json(400, {'error': '%s is not valid JSON: %s' % (p, e)})
            written = []
            for p, t in files.items():
                full = os.path.join(ROOT, *p.split('/'))
                try:
                    with open(full, encoding='utf-8', newline='') as f:
                        if f.read() == t:
                            continue
                except FileNotFoundError:
                    pass
                fd, tmp = tempfile.mkstemp(dir=os.path.dirname(full), prefix='.edit-')
                with os.fdopen(fd, 'w', encoding='utf-8', newline='') as f:
                    f.write(t)
                os.replace(tmp, full)
                written.append(p)
            return self._json(200, {'written': written})
        if method == 'POST' and route == 'check':
            node = shutil.which('node')
            if not node:
                return self._json(501, {'error': 'Node.js is not installed, so the checks can\'t run here'})
            out, ok = [], True
            for args in (['tools/bake.js', '--check'], ['tools/content.js', 'check'], ['tools/verify.js']):
                try:
                    r = subprocess.run([node] + args, cwd=ROOT, capture_output=True, text=True, timeout=300)
                    out.append('$ node ' + ' '.join(args) + '\n' + (r.stdout + r.stderr).strip())
                    if r.returncode != 0:
                        ok = False
                        break
                except subprocess.TimeoutExpired:
                    out.append('$ node ' + ' '.join(args) + '\ntimed out')
                    ok = False
                    break
            return self._json(200, {'ok': ok, 'output': '\n\n'.join(out)})
        return self._json(404, {'error': 'unknown api ' + route})

    def _gone(self):
        data = json.dumps({'detail': 'FriedrichBridge is retired: every merge is pre-baked in db/.', 'retryable': False}).encode()
        self.send_response(410)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/bridge/'):
            return self._gone()
        if self.path.startswith('/api/'):
            return self._api_get(self.path[5:].split('?')[0])
        path = self.translate_path(self.path)
        ctype = self.guess_type(path)
        if os.path.isfile(path) and 'gzip' in self.headers.get('Accept-Encoding', '') and ctype.startswith(GZIP_TYPES):
            with open(path, 'rb') as f:
                buf = io.BytesIO()
                with gzip.GzipFile(fileobj=buf, mode='wb', compresslevel=6, mtime=0) as z:
                    z.write(f.read())
            data = buf.getvalue()
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Encoding', 'gzip')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/bridge/'):
            return self._gone()
        if self.path.startswith('/api/'):
            return self._api_write('POST', self.path[5:].split('?')[0])
        self.send_error(405)

    def do_PUT(self):
        if self.path.startswith('/api/'):
            return self._api_write('PUT', self.path[5:].split('?')[0])
        self.send_error(405)


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--port', type=int, default=8090)
    ap.add_argument('--lan', action='store_true', help='listen on all interfaces so a phone on the same network can connect')
    args = ap.parse_args()
    host = '0.0.0.0' if args.lan else '127.0.0.1'
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer((host, args.port), Handler) as httpd:
        print(f'Essence Protocol on http://127.0.0.1:{args.port}')
        print(f'Content editor on http://127.0.0.1:{args.port}/editor/')
        ip = lan_ip() if args.lan else None
        if ip:
            print(f'On your phone (same Wi-Fi): http://{ip}:{args.port}')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
