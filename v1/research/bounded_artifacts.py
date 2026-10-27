"""Verify and selectively extract the frozen cloud archive for local reporting."""
import argparse
import hashlib
import json
import tarfile
from pathlib import Path
from research.bounded_io import compact_metadata


def extract(folder, scenario='pool-d0-h0-pub0', account_exits=('hold-45',), run_prefix='', account_memories=(20,)):
    folder = Path(folder)
    proof = json.loads((folder / 'artifact-manifest.json').read_text())
    bundle = json.loads((folder / 'bundle-proof.json').read_text())
    with (folder / 'results-bundle.tar.gz').open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != bundle['sha256']:
            raise ValueError('Archive hash mismatch')
    with (folder / 'artifact-manifest.json').open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != bundle['manifestHash']:
            raise ValueError('Manifest hash mismatch')
    written = 0
    with tarfile.open(folder / 'results-bundle.tar.gz', 'r|gz') as archive:
        for member in archive:
            name = member.name.removeprefix('./')
            parts = Path(name).parts
            if Path(name).is_absolute() or '..' in parts:
                raise ValueError('Unsafe archive member')
            if not member.isfile():
                continue
            keep = compact_metadata(name)
            relative = Path(name)
            if run_prefix:
                try:relative=relative.relative_to(run_prefix)
                except ValueError:relative=None
            selected_parts=relative.parts if relative else ()
            if len(selected_parts)>=3 and selected_parts[0]=='scenarios':
                selected=selected_parts[1]==scenario
                filename=selected_parts[-1]
                if len(selected_parts)==3:keep=selected
                elif selected_parts[2]=='accounts':
                    stems={f'{lane}-memory{memory}-{exit_name}{suffix}.json' for lane in ['fixed','corrected'] for memory in account_memories for exit_name in account_exits for suffix in ['','-pinned']}
                    keep=selected and filename.removesuffix('.gz') in stems
                elif selected_parts[2]=='scores':
                    keep=selected and selected_parts[3]=='core' and filename.startswith('fixed-memory20-hold-45-') and (filename.endswith('.json') or filename.endswith('.json.gz'))
                else:keep=False
                if filename.startswith('all-scorecards'):keep=False
            if not keep:
                continue
            expected = bundle['manifestHash'] if name == 'artifact-manifest.json' else proof['files'].get(name)
            if expected is None:
                raise ValueError('Unexpected archive member: ' + name)
            target = folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            temp = target.with_name(target.name + '.extracting')
            digest = hashlib.sha256()
            with temp.open('wb') as output:
                stream = archive.extractfile(member)
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != expected:
                temp.unlink()
                raise ValueError('Artifact hash mismatch: ' + name)
            temp.replace(target)
            written += 1
    return {'extracted': written, 'scenario': scenario, 'accountExits':list(account_exits),'accountMemories':list(account_memories),'runPrefix':run_prefix,'archiveVerified': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--folder', required=True)
    parser.add_argument('--scenario',default='pool-d0-h0-pub0')
    parser.add_argument('--account-exits',default='hold-45')
    parser.add_argument('--account-memories',default='20')
    parser.add_argument('--run-prefix',default='')
    args = parser.parse_args()
    print(json.dumps(extract(args.folder, args.scenario, args.account_exits.split(','),args.run_prefix,[int(n) for n in args.account_memories.split(',')])))
