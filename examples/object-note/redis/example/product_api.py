#!/usr/bin/env python3
"""Cache aside example. File parsed once; Redis failures return 502."""
import argparse
import http.client
import json
import threading
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, quote


def serve(port, redis_port, ttl, path):
    products = {p['id']: p for p in json.loads(Path(path).read_text())}
    stats = dict(origin=0, hit=0, miss=0, error=0)
    lock = threading.Lock()

    def count(name):
        with lock:
            stats[name] += 1

    def lookup_product(pid):
        count('origin')
        return products.get(pid)

    def redis(method, key, body=None):
        c = http.client.HTTPConnection('127.0.0.1', redis_port, timeout=5)
        try:
            c.request(method, '/keys/' + quote(key, safe=''), body,
                      {'Content-Type': 'application/json'})
            r = c.getresponse()
            return r.status, r.read()
        finally:
            c.close()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def setup(self):
            super().setup()
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        def log_message(self, *args):
            pass

        def reply(self, status, obj, source=None):
            body = json.dumps(obj, separators=(',', ':'), ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            if source:
                self.send_header('X-Data-Source', source)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path == '/stats':
                with lock:
                    snapshot = dict(stats)
                self.reply(200, snapshot)
                return
            if not url.path.startswith('/products/'):
                self.reply(404, {'error': 'route'})
                return
            pid = url.path[len('/products/'):]
            mode = parse_qs(url.query).get('cache', ['off'])[0]
            if mode not in ('on', 'off'):
                self.reply(400, {'error': 'cache mode'})
                return
            try:
                if mode == 'on':
                    status, body = redis('GET', 'product:' + pid)
                    if status == 200:
                        product = json.loads(json.loads(body)['value'])
                        count('hit')
                        self.reply(200, product, 'redis')
                        return
                    if status != 404:
                        raise RuntimeError('Redis GET status ' + str(status))
                    count('miss')
                product = lookup_product(pid)
                if product is None:
                    self.reply(404, {'error': 'product'})
                    return
                if mode == 'on':
                    status, _ = redis('PUT', 'product:' + pid, json.dumps(
                        {'value': json.dumps(product), 'ttl_seconds': ttl}).encode())
                    if status != 204:
                        raise RuntimeError('Redis PUT status ' + str(status))
                self.reply(200, product, 'origin')
            except (OSError, ValueError, RuntimeError, http.client.HTTPException):
                count('error')
                self.reply(502, {'error': 'cache unavailable'})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, default=8080)
    p.add_argument('--redis-port', type=int, default=6380)
    p.add_argument('--ttl', type=int, default=60)
    p.add_argument('--products', default=str(Path(__file__).with_name('products.json')))
    a = p.parse_args()
    if a.ttl <= 0:
        p.error('TTL must be positive')
    serve(a.port, a.redis_port, a.ttl, a.products)
