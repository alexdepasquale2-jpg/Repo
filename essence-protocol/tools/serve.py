#!/usr/bin/env python3
"""Serve Essence Protocol locally.

    python tools/serve.py                 -> http://127.0.0.1:8090
    python tools/serve.py --lan           -> also reachable from a phone on the same Wi-Fi

The game is fully static: every merge is pre-baked in db/ and nothing is generated live,
so this is just a file server. It gzips text (as a real host would), sends no-store so
edits show up on reload, and answers the retired FriedrichBridge proxy routes (/bridge/*)
with 410 Gone. Browsers only enable the service worker (offline play) on localhost or
HTTPS, so over --lan the game runs but does not install for offline use.
"""
import argparse
import gzip
import http.server
import io
import json
import os
import socket
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GZIP_TYPES = ('text/', 'application/json', 'application/javascript', 'image/svg+xml', 'application/manifest+json')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'application/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json'}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

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
        ip = lan_ip() if args.lan else None
        if ip:
            print(f'On your phone (same Wi-Fi): http://{ip}:{args.port}')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
