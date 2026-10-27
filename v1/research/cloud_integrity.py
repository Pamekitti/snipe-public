"""Independently verify frozen inputs and every completed cloud checkpoint."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

ROOT = Path('/work/results')
read = lambda p: json.loads(Path(p).read_text())


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    os.chdir('/work/bot')
    freeze = read(ROOT / 'run-freeze.json')
    freeze_hash = digest(ROOT / 'run-freeze.json')
    failures = []

    def check(condition, detail):
        if not condition:
            failures.append(detail)

    actual_sources = {str(p): digest(p) for folder in ['src', 'research/core', 'scripts']
                      for p in Path(folder).rglob('*') if p.suffix in ['.ts', '.py']}
    check(actual_sources == freeze['sources'], 'source inventory or hash mismatch')
    check(digest(ROOT / 'input-manifest.json') == freeze['inputManifestHash'], 'input manifest mismatch')
    check(digest('research/core/cloud-exits.json') == freeze['exitDescriptorsHash'], 'exit descriptors mismatch')
    identity = json.loads(subprocess.check_output(
        ['node', '--import', 'tsx', 'scripts/execution-worker.ts'],
        input=b'{"op":"identity"}\n',
        env={**os.environ, 'ENV_FILE': '/dev/null', 'MODE': 'observe', 'LIVE': '0', 'DASH': '0', 'DOTENV_CONFIG_QUIET': 'true'}))['result']
    check(identity['modelHash'] == freeze['modelHash'], 'model identity mismatch')

    def checkpoint(path, args, input_key):
        expected = hashlib.sha256(json.dumps(dict(args=args, inputKey=input_key, freeze=freeze_hash)).encode()).hexdigest()
        proof = read(str(path) + '.checkpoint.json')
        check(proof['jobHash'] == expected, 'checkpoint identity: ' + str(path))
        check(proof['outputHash'] == digest(path), 'output hash: ' + str(path))

    inputs = read(ROOT / 'input-manifest.json')
    for chunk in inputs['chunks']:
        check(digest(chunk['path']) == chunk['sha256'], 'execution input: ' + chunk['path'])
        path = ROOT / 'matrices' / Path(chunk['path']).name
        checkpoint(path, ['node', '--import', 'tsx', 'research/core/cloud_execution.ts', chunk['path'], str(path)], chunk['sha256'])
    print('verified matrix checkpoints', len(inputs['chunks']), flush=True)
    accounts = read(ROOT / 'account-manifest.json')['inputs']
    for item in accounts:
        check(digest(item['path']) == item['sha256'], 'account input: ' + item['path'])
    print('verified account inputs', len(accounts), flush=True)
    jobs = 0
    for index_path in (ROOT / 'scores').glob('*/index.json'):
        index = read(index_path)
        for filename in index['files']:
            path = Path(filename)
            info = next(i for i in accounts if path.name.startswith(Path(i['path']).stem + '-'))
            group = path.stem[len(Path(info['path']).stem) + 1:]
            policy = index_path.parent / ('policies-' + group + '.json')
            args = ['node', '--import', 'tsx', 'research/core/cloud_score.ts', info['path'], str(policy), str(path)]
            checkpoint(path, args, info['sha256'] + digest(policy))
            jobs += 1
    print('verified score checkpoints', jobs, flush=True)
    rows = read(ROOT / 'all-scorecards.json')
    summary = read(ROOT / 'comparison-summary.json')
    check(len(rows) == summary['comparisons'] == 139200, 'core comparison count mismatch')
    complete = {period: sum(all(s['complete'] for s in r['periods'][period]) for r in rows)
                for period in ['train3', 'train5', 'train7', 'all']}
    result = dict(passed=not failures, failures=failures, modelHash=identity['modelHash'],
                  runFreezeHash=freeze_hash, matrixCheckpoints=len(inputs['chunks']),
                  accountInputs=len(accounts), scoreCheckpoints=jobs, coreComparisons=len(rows),
                  scenarioComparisons=sum(len(r['scenarios']) for r in rows),
                  completeComparisons=complete, diagnosticOnly=True)
    (ROOT / 'verification' / 'final-integrity.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    if failures:
        raise RuntimeError('Frozen artifact verification failed')


if __name__ == '__main__':
    main()
