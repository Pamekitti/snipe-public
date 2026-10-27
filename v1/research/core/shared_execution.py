"""Research orchestrates the same TypeScript execution and account code as paper."""
import os
import json
import pathlib
import subprocess
import tempfile

BOT = pathlib.Path(__file__).resolve().parents[2]
MODEL_VERSION = "execution-account-v3"


class ExecutionWorker:
    """Reuse one offline worker across batches. Each instance has one caller."""
    def __init__(self):
        self.stderr = tempfile.TemporaryFile(mode='w+t')
        self.process = subprocess.Popen(
            ["node", "--import", "tsx", "scripts/execution-worker.ts"], cwd=BOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
            text=True, bufsize=1,
            env={"PATH": os.environ["PATH"], "ENV_FILE": "/dev/null", "MODE": "observe", "LIVE": "0", "DASH": "0", "DOTENV_CONFIG_QUIET": "true"},
        )

    def call(self, operation, **inputs):
        if self.process.poll() is not None:
            raise RuntimeError('execution worker is not running')
        self.process.stdin.write(json.dumps(dict(op=operation, **inputs)) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            self.stderr.seek(0)
            raise RuntimeError('execution worker exited: ' + self.stderr.read()[-4000:])
        response = json.loads(line)
        if not response['ok']:
            raise RuntimeError(response['error'])
        return response['result']

    def close(self):
        if not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()
        self.stderr.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def execute_batch(operation, **inputs):
    # Keep the established one-shot API. Long runs opt into ExecutionWorker.
    with ExecutionWorker() as worker:
        return worker.call(operation, **inputs)
