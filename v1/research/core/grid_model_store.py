"""Lossless per-launch deduplication of identical exit results."""
import json

def pack_results(value):
    if 'result_pool' in value:raise ValueError('Already packed')
    pool=[];indices={};refs={}
    for key,result in value['results'].items():
        serialized=json.dumps(result,sort_keys=True,separators=(',',':'))
        if serialized not in indices:
            indices[serialized]=len(pool);pool.append(result)
        refs[key]=indices[serialized]
    return {k:v for k,v in value.items() if k!='results'} | dict(result_pool=pool,result_refs=refs)

def unpack_results(value):
    if 'results' in value:return value
    return {k:v for k,v in value.items() if k not in ('result_pool','result_refs')} | dict(results={key:value['result_pool'][index] for key,index in value['result_refs'].items()})
