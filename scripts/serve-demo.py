#!/usr/bin/env python3
"""Serve the static review tree on loopback. Non-read requests are refused."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
import argparse,os
parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8799);a=parser.parse_args()
root=Path(__file__).resolve().parents[1]
class ReadOnly(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(root),**kwargs)
 def refused(self):self.send_error(405,'Read-only historical demo')
 do_POST=do_PUT=do_PATCH=do_DELETE=refused
 def end_headers(self):
  self.send_header('Content-Security-Policy',"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
  self.send_header('Cache-Control','no-store');super().end_headers()
print(f'Read-only Snipe review: http://127.0.0.1:{a.port}/demo/',flush=True)
ThreadingHTTPServer(('127.0.0.1',a.port),ReadOnly).serve_forever()
