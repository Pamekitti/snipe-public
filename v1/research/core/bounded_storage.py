"""Lossless, hash-checked storage for completed sensitivity scenarios."""
import gzip
import shutil
from pathlib import Path
from .data import digest,read_json,write_json


def compress(path):
    path=Path(path);target=Path(str(path)+'.gz');temporary=Path(str(target)+'.tmp')
    original=digest(path)
    with path.open('rb') as source,temporary.open('wb') as output:
        with gzip.GzipFile(filename='',mode='wb',fileobj=output,compresslevel=1,mtime=0) as packed:
            shutil.copyfileobj(source,packed)
    # Verify the encoded representation before removing its plain source.
    import hashlib
    with gzip.open(temporary,'rb') as source:
        if hashlib.file_digest(source,'sha256').hexdigest()!=original:raise ValueError('Compression changed input')
    temporary.replace(target);path.unlink()
    return {'plainHash':original,'gzipHash':digest(target)}


def complete(folder,parent_freeze):
    folder=Path(folder)
    for subdir in ['accounts','scores']:
        for path in (folder/subdir).rglob('*.json'):
            if not path.name.endswith(('.checkpoint.json','.progress.json')):compress(path)
    if (folder/'all-scorecards.json').exists():compress(folder/'all-scorecards.json')
    files={str(path.relative_to(folder)):digest(path) for path in folder.rglob('*') if path.is_file() and path.name not in ['scenario-complete.json','status.json'] and not path.name.endswith(('.tmp','.log','.progress.json'))}
    write_json(folder/'scenario-complete.json',{'parentFreeze':parent_freeze,'files':files})


def is_complete(folder,parent_freeze):
    folder=Path(folder);path=folder/'scenario-complete.json'
    if not path.exists():return False
    proof=read_json(path)
    if proof.get('parentFreeze')!=parent_freeze:raise ValueError('Completed scenario uses another freeze')
    for name,expected in proof['files'].items():
        path=folder/name
        if not path.is_file() or digest(path)!=expected:raise ValueError('Completed scenario artifact changed: '+name)
    return True


def restore_partial(folder):
    """Recover plain checkpoint inputs after interruption during compression."""
    folder=Path(folder)
    for subdir in ['accounts','scores']:
        for path in (folder/subdir).rglob('*.json.gz'):
            target=path.with_suffix('')
            if target.exists():continue
            temporary=Path(str(target)+'.tmp')
            with gzip.open(path,'rb') as source,temporary.open('wb') as output:shutil.copyfileobj(source,output)
            temporary.replace(target)
