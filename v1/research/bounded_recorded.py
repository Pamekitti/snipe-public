"""Build a separately labeled baseline reference with recorded gate publication floors."""
import argparse
import json
import os
import subprocess
from pathlib import Path
from research.core import cloud_accounts
from research.core.data import digest, read_json, write_json


def run(root):
    root = Path(root)
    base = root / 'scenarios' / 'pool-d0-h0-pub0'
    target = root / 'recorded-publication-reference'
    matrices = target / 'matrices'
    matrices.mkdir(parents=True, exist_ok=True)
    manifest = read_json(base / 'input-manifest.json')
    expected = manifest['preparedMatrices']
    for name, checksum in expected.items():
        source = base / 'matrices' / name
        if digest(source) != checksum:
            raise ValueError('Frozen base matrix mismatch')
        destination = matrices / name
        if not destination.exists():
            destination.symlink_to(source.resolve())
    manifest['publicationPolicy'] = {'kind': 'recorded'}
    manifest['publicationExtraDelayMs'] = 0
    manifest['referencePurpose'] = 'Recorded gate floors, including historical backfill gaps. No candidate fitting.'
    write_json(target / 'input-manifest.json', manifest)
    # Select one existing exit descriptor without changing its execution or selector logic.
    previous = cloud_accounts.EXITS
    try:
        cloud_accounts.EXITS = ['hold-45']
        cloud_accounts.run(target)
    finally:
        cloud_accounts.EXITS = previous
    policy = dict(id='conservative-10-5', n=10, m=5, off=-2, freshOn=1,
                  fullOn=2, ageMs=10800000, mode='both')
    for lane in ['fixed', 'corrected']:
        data = read_json(target / 'accounts' / (lane + '-memory20-hold-45.json'))
        data['policy'] = policy
        response = subprocess.run(['node', '--import', 'tsx', 'scripts/execution-worker.ts'],
            input=json.dumps({'op': 'scenario-accounts', 'input': data}), capture_output=True,
            text=True, check=True, env={**os.environ, 'ENV_FILE': '/dev/null', 'MODE': 'observe',
                                      'LIVE': '0', 'DASH': '0', 'DOTENV_CONFIG_QUIET': 'true'})
        result = json.loads(response.stdout)['result']
        write_json(target / (lane + '-baseline.json'), result)
    # The source matrices remain in the main run and its archive.
    for path in matrices.iterdir():
        path.unlink()
    matrices.rmdir()
    write_json(target / 'reference-complete.json', {'complete': True, 'fittedCandidates': 0,
        'sourceManifestHash': digest(base / 'input-manifest.json'),
        'referenceManifestHash': digest(target / 'input-manifest.json'),
        'modelHash': read_json(root / 'run-freeze.json')['modelHash'],
        'referenceScriptHash': digest(__file__)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    args = parser.parse_args()
    run(args.root)
