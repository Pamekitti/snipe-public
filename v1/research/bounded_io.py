"""Resolve the archived active research version without losing superseded results."""
from pathlib import Path
from research.core.data import read_json

def active_results(folder):
    folder=Path(folder);pointer=folder/'active-run.json'
    if not pointer.exists():return folder
    name=Path(read_json(pointer)['path'])
    if name.is_absolute() or '..' in name.parts:raise ValueError('Unsafe active run path')
    return folder/name

def compact_metadata(name):
    parts=Path(name).parts
    if 'accounts' in parts or 'account-batches' in parts or 'matrices' in parts or 'hydrated' in parts:return False
    return ('/' not in name or name.startswith('report/') or name.startswith('verification/') or
            (parts[0].startswith('optimized-v') and (len(parts)==2 or 'verification' in parts or 'report' in parts)))
