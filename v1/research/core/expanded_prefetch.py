"""Batch missing header reads without changing the frozen verification checks."""
import argparse
import hashlib
import json
from pathlib import Path

from . import expanded_sample
from .data import Cache


def run(root):
    root=Path(root)
    jobs=json.loads((root/'source-jobs.json').read_text())
    known={key: header['hash'].lower() for job in jobs for key,header in job['headers'].items() if header}

    class PrefetchCache(Cache):
        def get(self,method,params):
            result=super().get(method,params)
            if method=='eth_getLogs' and result:
                blocks=sorted({l['blockNumber'] for l in result if known.get(l['blockNumber'])!=l['blockHash'].lower()},key=lambda n:int(n,16))
                for start in range(0,len(blocks),20):
                    # Cache.many performs one bounded HTTP batch, with its usual backoff.
                    self.many([('eth_getBlockByNumber',[block,False]) for block in blocks[start:start+20]])
            return result

    expanded_sample.write(root/'verification-execution.json',dict(
        checkerSha256=hashlib.sha256(Path(expanded_sample.__file__).read_bytes()).hexdigest(),
        prefetchSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        change='Read scheduling only: prefetch at most 20 missing block headers per HTTP batch before the unchanged per-log hash and timestamp checks.',
        inputHash=hashlib.sha256((root/'source-jobs.json').read_bytes()).hexdigest(),concurrency=1,liveChanges=False))
    expanded_sample.Cache=PrefetchCache
    expanded_sample.verify_sources(root)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);args=parser.parse_args();run(args.root)
