"""One daily local snapshot; durable commits and retryable, non-forced Git pushes."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.export_world import export_snapshot, ZONE
from scripts.validate import validate_data

GENERATED = ('site/data', 'site/downloads')


def git(repo, *args, check=True):
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_EDITOR': 'true'}
    env.setdefault('GIT_SSH_COMMAND', 'ssh -o BatchMode=yes -o ConnectTimeout=15')
    result = subprocess.run(['git', '-C', str(repo), *args], text=True, capture_output=True, env=env, timeout=120)
    if check and result.returncode:
        raise RuntimeError(f'git {args[0]} failed: {result.stderr.strip()}')
    return result


def generated(path):
    return any(path == prefix or path.startswith(prefix + '/') for prefix in GENERATED)


def recover_interrupted_export(repo):
    """Only generated, uncommitted data is recoverable. Preserve all hand-written work."""
    changed = set()
    for args in [('diff', '--name-only', '-z'), ('diff', '--cached', '--name-only', '-z'),
                 ('ls-files', '--others', '--exclude-standard', '-z')]:
        changed.update(p for p in git(repo, *args).stdout.split('\0') if p)
    if any(not generated(path) for path in changed):
        raise RuntimeError('Checkout has hand-written changes; automatic publishing paused')
    if changed:
        git(repo, 'restore', '--source=HEAD', '--staged', '--worktree', '--', *GENERATED)
        git(repo, 'clean', '-fd', '--', *GENERATED)
        print('Recovered interrupted generated-data changes from the last local commit', flush=True)


def align_remote(repo):
    fetched = git(repo, 'fetch', 'origin', 'main', check=False)
    if fetched.returncode:
        print('Remote unavailable; daily snapshot will still be committed locally', flush=True)
        return
    if git(repo, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main', check=False).returncode == 0:
        git(repo, 'merge', '--ff-only', 'origin/main')
    elif git(repo, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD', check=False).returncode:
        rebased = git(repo, 'rebase', 'origin/main', check=False)
        if rebased.returncode:
            git(repo, 'rebase', '--abort', check=False)
            raise RuntimeError('Upstream changes conflict with unpublished snapshots; history preserved, resolve manually')


def publish(repo, state_dir, source_root, now=None, force=False, exporter=export_snapshot):
    repo, state_dir = Path(repo).resolve(), Path(state_dir).resolve()
    now = now or datetime.now(timezone.utc)
    assert git(repo, 'branch', '--show-current').stdout.strip() == 'main', 'Publish from main only'
    recover_interrupted_export(repo)
    align_remote(repo)
    manifest = repo / 'site/data/world.json'
    previous_day = json.loads(manifest.read_text())['snapshot_day'] if manifest.exists() else None
    day = now.astimezone(ZONE).date().isoformat()
    captured = force or previous_day is None or previous_day < day
    if captured:
        state_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='export-', dir=state_dir) as temporary:
            stage = Path(temporary)
            exporter(stage, Path(source_root), now=now, previous_day=previous_day)
            validate_data(stage)
            for prefix in GENERATED:
                destination = repo / prefix
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.copytree(stage / Path(prefix).name, destination)
        git(repo, 'add', '--', *GENERATED)
        if git(repo, 'diff', '--cached', '--quiet', check=False).returncode:
            git(repo, '-c', 'user.name=Easter Co. Cartographer', '-c', 'user.email=cartographer@users.noreply.github.com',
                'commit', '-m', f'World snapshot · {day}')
        print(f'Daily snapshot committed: {day}', flush=True)
    else:
        print(f'Already charted {day}; retrying any unpublished commits', flush=True)
    # A failed push intentionally leaves every snapshot in local Git for the next run.
    git(repo, 'push', 'origin', 'HEAD:main')
    print('Snapshot history synchronized with GitHub', flush=True)
    return captured


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/easter-co-pages'))
    parser.add_argument('--source-root', type=Path, default=Path('/root/e-server'))
    parser.add_argument('--force', action='store_true', help='Capture again today, retaining the real capture time')
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (args.state_dir / 'publish.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another snapshot export is running; leaving it in charge')
            return
        publish(args.repo, args.state_dir, args.source_root, force=args.force)


if __name__ == '__main__':
    main()
