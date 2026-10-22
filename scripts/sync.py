"""Two independent daily publications: the client manifest, and the world snapshot.

The client half (site/data/client.json and site/downloads/) is rebuilt from the canonical
artifacts on every run and is committed and pushed before the map half starts, so a map
capture that refuses cannot freeze a client release for days -- which is what happened
from 2026-10-19 to 2026-10-22. The map half keeps its refusal gate: when the snapshot
source cannot be read it keeps the published snapshot untouched, says so in one line
naming the reason, and exits 0; a source that is present but broken still fails the run.
"""
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
#: The one seam the verified remote snapshot source replaces (ticket 9ee87d22: wake the game
#: host, snapshot the live world to S3, render from it). That module supplies the same two
#: names this file uses -- export_world_snapshot(), which stages data/world.json plus
#: data/tiles, and snapshot_source_refusal(), which returns the reason its source cannot be
#: read or None -- so its arrival changes this import line and nothing else here.
from scripts import export_world as snapshot_source
from scripts.export_world import (PublishedClientArtifacts, SnapshotSourceUnavailable, ZONE,
                                 export_client)
from scripts.validate import validate_client, validate_world

GENERATED = ('site/data', 'site/downloads')
#: The two halves write disjoint parts of the generated tree, so neither can block the other.
CLIENT_OUTPUTS = (('site/data/client.json', 'data/client.json'), ('site/downloads', 'downloads'))
WORLD_OUTPUTS = (('site/data/world.json', 'data/world.json'), ('site/data/tiles', 'data/tiles'))


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


def apply_outputs(repo, stage, outputs):
    """Copy one half's staged output into the publishing checkout, and nothing else."""
    for target, staged in outputs:
        source, destination = stage / staged, repo / target
        if not source.exists():
            raise FileNotFoundError(f'the staged export is missing {staged}')
        if source.is_dir():
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(source, destination)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)


def stage_client(stage, state_dir, now=None):
    """The client half's default source: canonical artifacts and the reviewed published pins."""
    export_client(Path(stage), PublishedClientArtifacts(), now=now,
                  state_path=Path(state_dir) / 'modrinth.json')


def publish_client(repo, state_dir, now=None, exporter=None):
    """Publish site/data/client.json and site/downloads/, whatever the map capture does.

    The manifest is rebuilt from /opt/minecraft/client-mods on every run, so a new mod
    reaches players on the next timer tick instead of waiting for a map capture that may be
    refusing for days. The staged half is validated on its own first, so a broken client
    manifest fails the run without touching the checkout.
    """
    exporter = exporter or stage_client
    state_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='client-', dir=state_dir) as temporary:
        stage = Path(temporary)
        exporter(stage, state_dir, now=now)
        validate_client(stage)
        apply_outputs(repo, stage, CLIENT_OUTPUTS)


def publish_map(repo, state_dir, source_root, now, force=False, exporter=None):
    """Chart today's world, or keep the published snapshot and say why.

    Returns True only when this run captured a fresh world. When the snapshot source cannot
    be read the published snapshot stands byte for byte: site/data/world.json keeps its own
    snapshot_day and gains nothing that claims freshness, and one line names the reason and
    the day that is actually published. A source that is present but broken still raises.
    """
    exporter = exporter or snapshot_source.export_world_snapshot
    manifest = repo / 'site/data/world.json'
    published_day = json.loads(manifest.read_text())['snapshot_day'] if manifest.exists() else None
    day = now.astimezone(ZONE).date().isoformat()
    reason = snapshot_source.snapshot_source_refusal()
    if reason is not None:
        if published_day is None:
            # Nothing published to keep: a refusal with no snapshot behind it is a failure.
            raise SnapshotSourceUnavailable(reason)
        print(f'Map capture reused the published snapshot (snapshot_day {published_day}); '
              f'nothing was captured: {reason}', flush=True)
        return False
    if not (force or published_day is None or published_day < day):
        print(f'Already charted {day}; the published snapshot stands', flush=True)
        return False
    state_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='export-', dir=state_dir) as temporary:
        stage = Path(temporary)
        exporter(stage, Path(source_root), now=now, previous_day=published_day)
        validate_world(stage)
        apply_outputs(repo, stage, WORLD_OUTPUTS)
    return True


def commit(repo, message):
    """Commit the generated tree, reporting whether anything was actually committed."""
    paths = [prefix for prefix in GENERATED if (repo / prefix).exists()]
    if not paths:
        return False
    git(repo, 'add', '--', *paths)
    if not git(repo, 'diff', '--cached', '--quiet', check=False).returncode:
        return False
    git(repo, '-c', 'user.name=Easter Co. Cartographer', '-c', 'user.email=cartographer@users.noreply.github.com',
        'commit', '-m', message)
    return True


def publish(repo, state_dir, source_root, now=None, force=False, exporter=None, client_exporter=None):
    """Publish the client half, then the map half; each one's failure is its own.

    The client half is committed and pushed on its own before the map half starts, so
    neither a map refusal nor a genuine map fault can hold a client release back. Both
    halves are attempted and their failures reported together, because a broken client
    manifest must not decide whether the world is captured either. Returns True only when
    this run captured a fresh world.
    """
    repo, state_dir = Path(repo).resolve(), Path(state_dir).resolve()
    now = now or datetime.now(timezone.utc)
    assert git(repo, 'branch', '--show-current').stdout.strip() == 'main', 'Publish from main only'
    recover_interrupted_export(repo)
    align_remote(repo)
    state_dir.mkdir(parents=True, exist_ok=True)
    day = now.astimezone(ZONE).date().isoformat()
    failures, captured = [], False
    try:
        publish_client(repo, state_dir, now=now, exporter=client_exporter)
        if commit(repo, f'Client publication · {day}'):
            print(f'Client publication committed: {day}', flush=True)
            git(repo, 'push', 'origin', 'HEAD:main')
    except Exception as error:
        failures.append(f'Client publication failed: {error}')
    try:
        captured = publish_map(repo, state_dir, source_root, now=now, force=force, exporter=exporter)
        if captured:
            commit(repo, f'World snapshot · {day}')
            print(f'Daily snapshot committed: {day}', flush=True)
        # A failed push intentionally leaves every snapshot in local Git for the next run.
        git(repo, 'push', 'origin', 'HEAD:main')
        print('Snapshot history synchronized with GitHub', flush=True)
    except Exception as error:
        failures.append(f'Map capture failed: {error}')
    if failures:
        raise RuntimeError('; '.join(failures))
    return captured


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/easter-co-pages'))
    parser.add_argument('--source-root', type=Path, default=Path('/root/e-server'))
    parser.add_argument('--force', action='store_true',
                        help='Capture again today, retaining the real capture time. It cannot '
                             'override an unavailable snapshot source: the published snapshot is reused.')
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
