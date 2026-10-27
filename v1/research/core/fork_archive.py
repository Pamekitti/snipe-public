"""Single-reader, durable, read-only archive transport for localhost EVM forks."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from .data import Cache

ALLOWED = {'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
           'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getTransactionCount',
           'eth_getLogs', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getProof', 'eth_call',
           'eth_gasPrice', 'eth_feeHistory', 'web3_clientVersion', 'net_version'}


def reply(cache, query):
    method, params = query['method'], query.get('params', [])
    if method not in ALLOWED:
        raise ValueError('read-only archive')
    value = cache.get(method, params)
    row = {'jsonrpc': '2.0', 'id': query.get('id')}
    failure = cache.db.execute('select error from failures where key=?', (cache.key(method, params),)).fetchone()
    nullable = method in {'eth_getTransactionReceipt', 'eth_getTransactionByHash'}
    if value is not None or nullable and failure and failure[0] == 'missing result':
        row['result'] = value
    else:
        row['error'] = {'code': -32000, 'message': 'historical archive evidence unavailable'}
    return row


def serve(cache_path, upstream, port):
    with Cache(cache_path, True, url=upstream, headers_url=upstream, logs_url=upstream) as cache:
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size <= 2000000:
                    self.send_error(413)
                    return
                try:
                    body = json.loads(self.rfile.read(size))
                    batch = body if isinstance(body, list) else [body]
                    if not batch or any(q.get('method') not in ALLOWED for q in batch):
                        print('Rejected methods:', [q.get('method') for q in batch], flush=True)
                        self.send_error(403, 'read-only archive')
                        return
                    rows = []
                    for q in batch:
                        rows.append(reply(cache,q))
                    payload = json.dumps(rows if isinstance(body, list) else rows[0]).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (ValueError, TypeError, KeyError):
                    self.send_error(400, 'invalid archive request')
        server = HTTPServer(('127.0.0.1', port), Handler)
        print('Read-only cached archive ready', flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', required=True)
    parser.add_argument('--upstream', required=True)
    parser.add_argument('--port', type=int, default=16875)
    args = parser.parse_args()
    serve(args.cache, args.upstream, args.port)
