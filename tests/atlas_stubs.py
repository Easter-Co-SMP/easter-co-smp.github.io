"""Stubs for the four services the atlas pipeline talks to, and fixtures that build captures.

Everything here is a fake: no AWS call, no GitHub call, no network. The stubs are recording
fakes -- every call is appended to `calls` -- because three of the ticket's acceptance
criteria are counts of calls that must NOT happen ("zero starts, zero SSM sends, zero
uploads, zero commits").

They are deliberately small and dumb: a stub that guesses is a stub that can hide a bug. The
real HTTP surface of the GitHub API is exercised separately against a local server in
`tests/test_atlas_publish.py`.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import tarfile

from scripts.atlas import contract
from scripts.atlas.publish import blob_sha

REPO_ROOT = Path(__file__).resolve().parents[1]


class FakeClientError(Exception):
    """The shape botocore raises, near enough for the pipeline's own error handling."""

    def __init__(self, code, message="fake failure"):
        super().__init__(f"{code}: {message}")
        self.response = {"Error": {"Code": code, "Message": message}}


class Body:
    def __init__(self, data):
        self._data = data

    def read(self, size=-1):
        if size is None or size < 0:
            data, self._data = self._data, b""
            return data
        chunk, self._data = self._data[:size], self._data[size:]
        return chunk


class Stub:
    def __init__(self):
        self.calls = []

    def count(self, name):
        return sum(1 for call in self.calls if call[0] == name)

    def names(self):
        return [call[0] for call in self.calls]


class StubS3(Stub):
    def __init__(self, objects=None):
        super().__init__()
        self.objects = dict(objects or {})
        self.upload_hook = None

    def put_object(self, **kwargs):
        self.calls.append(("put_object", kwargs.get("Key")))
        if self.failures.get("put_object"):
            raise self.failures["put_object"]
        self.objects[kwargs["Key"]] = kwargs["Body"]
        return {}

    # A tiny failure-injection switch, so one test per failing stage is one line each.
    @property
    def failures(self):
        return self.__dict__.setdefault("_failures", {})

    def get_object(self, **kwargs):
        self.calls.append(("get_object", kwargs.get("Key")))
        if self.failures.get("get_object"):
            raise self.failures["get_object"]
        key = kwargs["Key"]
        if key not in self.objects:
            raise FakeClientError("NoSuchKey", key)
        return {"Body": Body(self.objects[key])}

    def head_object(self, **kwargs):
        self.calls.append(("head_object", kwargs.get("Key")))
        if self.failures.get("head_object"):
            raise self.failures["head_object"]
        key = kwargs["Key"]
        if key not in self.objects:
            raise FakeClientError("404", key)
        return {"ContentLength": len(self.objects[key])}


class StubEC2(Stub):
    """The three EC2 calls the pipeline makes, with injectable failures and a state machine."""

    def __init__(self, state="stopped", launch_time="2026-10-20T09:00:00+00:00",
                 transition_reason="User initiated (2026-10-20 09:00:00 GMT)",
                 instance_id="i-0123456789abcdef0"):
        super().__init__()
        self.state = state
        self.launch_time = launch_time
        self.state_transition_reason = transition_reason
        self.instance_id = instance_id
        self.failures = {}
        #: What `stop_instances` does to the reported state. A test that wants an unconfirmed
        #: stop sets this to a no-op and asserts the loud refusal.
        self.stop_takes_effect = True

    def describe_instances(self, **kwargs):
        self.calls.append(("describe_instances", tuple(kwargs.get("InstanceIds") or ())))
        if self.failures.get("describe_instances"):
            raise self.failures["describe_instances"]
        return {"Reservations": [{"Instances": [{
            "InstanceId": self.instance_id,
            "State": {"Name": self.state},
            "LaunchTime": self.launch_time,
            "StateTransitionReason": self.state_transition_reason,
        }]}]}

    def start_instances(self, **kwargs):
        self.calls.append(("start_instances", tuple(kwargs.get("InstanceIds") or ())))
        if self.failures.get("start_instances"):
            raise self.failures["start_instances"]
        self.state = "running"
        self.state_transition_reason = "User initiated (2026-10-22 04:30:00 GMT)"
        return {"StartingInstances": [{"CurrentState": {"Name": "pending"},
                                       "PreviousState": {"Name": "stopped"}}]}

    def stop_instances(self, **kwargs):
        self.calls.append(("stop_instances", tuple(kwargs.get("InstanceIds") or ())))
        if self.failures.get("stop_instances"):
            raise self.failures["stop_instances"]
        if self.stop_takes_effect:
            self.state = "stopped"
            self.state_transition_reason = "User initiated (2026-10-22 04:31:00 GMT)"
        return {"StoppingInstances": [{"CurrentState": {"Name": "stopping"},
                                       "PreviousState": {"Name": "running"}}]}


class StubSSM(Stub):
    """Run Command, with a per-command hook so a test can watch what the host would do."""

    def __init__(self):
        super().__init__()
        self.commands = {}
        self.results = {}        # comment -> (status, stdout, stderr)
        self.hooks = {}          # comment -> callable(command_text)
        self.failures = {}
        self._counter = 0

    def send_command(self, **kwargs):
        comment = kwargs.get("Comment") or ""
        text = (kwargs.get("Parameters") or {}).get("commands", [""])[0]
        self.calls.append(("send_command", comment))
        if self.failures.get("send_command"):
            raise self.failures["send_command"]
        self._counter += 1
        command_id = f"cmd-{self._counter}"
        self.commands[command_id] = {"comment": comment, "text": text, "kwargs": kwargs}
        hook = self.hooks.get(comment)
        if hook is not None:
            hook(text)
        return {"Command": {"CommandId": command_id}}

    def get_command_invocation(self, **kwargs):
        command_id = kwargs["CommandId"]
        self.calls.append(("get_command_invocation", command_id))
        if self.failures.get("get_command_invocation"):
            raise self.failures["get_command_invocation"]
        record = self.commands.get(command_id)
        if record is None:
            raise FakeClientError("InvocationDoesNotExist", command_id)
        status, stdout, stderr = self.results.get(record["comment"], ("Success", "", ""))
        return {"Status": status, "StandardOutputContent": stdout,
                "StandardErrorContent": stderr, "ResponseCode": 0 if status == "Success" else 1}

    def sent(self, comment):
        return [record["text"] for record in self.commands.values()
                if record["comment"] == comment]


class RecordingGitHub:
    """The Git Data API in memory: enough semantics to count commits and diff their trees."""

    def __init__(self, files=None):
        self.trees = {"tree-0": dict(files or {})}
        self.head = "commit-0"
        self.commits = []          # {'message','sha','files':{path: sha},'changed':[...]}
        self.blobs = {}
        self.calls = []
        self.fail_fast_forward = 0  # how many PATCHes to refuse, to exercise the retry
        self._counter = 0

    # ── the surface publish.publish() uses ───────────────────────────────────────────
    def branch_head(self, branch="main"):
        self.calls.append("branch_head")
        return self.head

    def commit_tree(self, sha):
        self.calls.append("commit_tree")
        return "tree-0"

    def tree(self, sha):
        self.calls.append("tree")
        return {"tree": [{"path": path, "type": "blob", "mode": "100644", "sha": digest}
                         for path, digest in sorted(self.trees["tree-0"].items())]}

    def blob(self, data):
        self.calls.append("blob")
        digest = blob_sha(data)
        self.blobs[digest] = data
        return digest

    def create_tree(self, base_tree, entries):
        self.calls.append("create_tree")
        updated = dict(self.trees["tree-0"])
        for entry in entries:
            if entry.get("sha") is None:
                updated.pop(entry["path"], None)
            else:
                updated[entry["path"]] = entry["sha"]
        self._counter += 1
        name = f"tree-{self._counter}"
        self.trees[name] = updated
        return name

    def create_commit(self, message, tree, parents):
        self.calls.append("create_commit")
        self._counter += 1
        sha = f"commit-{self._counter}"
        files = dict(self.trees[tree])
        parent = dict(self.trees.get("tree-0", {}))
        changed = sorted(path for path, digest in files.items() if parent.get(path) != digest)
        changed += sorted(path for path in parent if path not in files)
        self.commits.append({"message": message, "sha": sha, "tree": tree,
                             "files": files, "changed": changed, "parents": list(parents)})
        self.trees[tree] = files
        return sha

    def fast_forward(self, sha, branch="main"):
        self.calls.append("fast_forward")
        if self.fail_fast_forward:
            self.fail_fast_forward -= 1
            from scripts.atlas.publish import PublishError
            raise PublishError("PATCH /git/refs/heads/main -> HTTP 422: not a fast forward")
        self.head = sha
        self.trees["tree-0"] = dict(self.trees[self.commits[-1]["tree"]])
        return {}

    # ── assertions helpers ───────────────────────────────────────────────────────────
    @property
    def commit_count(self):
        return len(self.commits)

    def messages(self):
        return [commit["message"] for commit in self.commits]

    def committed_paths(self):
        rows = []
        for commit in self.commits:
            rows.extend(commit["changed"])
        return rows


# ── fixtures ─────────────────────────────────────────────────────────────────────────

def seed_client_state(staging, published):
    """A resolution state built from the published manifest, so a client rebuild needs no network.

    This is the honest shape of the real cache: `modrinth.json` holds confirmed upstream files,
    and `graphics*.json` hold the confirmed pack and loader. Seeding them from the published
    document means a test proves "an unchanged world republishes nothing" without pretending
    Modrinth answered.
    """
    staging = Path(staging)
    staging.mkdir(parents=True, exist_ok=True)
    base = next(chunk for chunk in published["chunks"] if chunk["id"] == "base")
    entries = {entry["id"]: {"name": entry["path"], "version": entry["version"],
                             "url": entry["url"], "hash": entry["hash"], "size": entry["size"]}
               for entry in base["files"] if entry["id"] != "easter-navy"}
    (staging / "modrinth.json").write_text(json.dumps({"entries": entries, "checked": {}}, indent=2))
    graphics = next((chunk for chunk in published["chunks"] if chunk["id"] == "graphics"), None)
    if graphics:
        keys = ("name", "version", "path", "url", "hash", "size")
        (staging / "graphics.json").write_text(json.dumps(
            {key: graphics["files"][0][key] for key in keys}))
        (staging / "graphics-companions.json").write_text(json.dumps({
            "versions": [entry["version"] for entry in graphics["files"][1:]],
            "files": [{key: entry[key] for key in ("id",) + keys} for entry in graphics["files"][1:]],
        }))
    return staging


def make_capture(destination, *, regions=None, level_dat=b"level-data", zones=None,
                 config=None, positions=None, captured_at="2026-10-22T04:30:00Z",
                 instance_id="i-0123456789abcdef0", region_bytes=None):
    """Build a capture tarball with the frozen layout, and the sidecar that describes it."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    root = destination / "capture-tree"
    region_dir = root / "world" / contract.WORLD_REGION_DIR
    region_dir.mkdir(parents=True, exist_ok=True)
    regions = regions if regions is not None else [(-25, 7), (-23, 5), (0, 0)]
    for x, z in regions:
        payload = region_bytes if region_bytes is not None else (b"\x00" * 4096 + bytes([x % 251, z % 251]))
        (region_dir / f"r.{x}.{z}.mca").write_bytes(payload)
    (root / "world" / contract.WORLD_LEVEL_DAT).write_bytes(level_dat)

    capture = root / "capture"
    (capture / "config").mkdir(parents=True, exist_ok=True)
    manifest = {"schema": 1, "capture_id": "test-capture", "captured_at": captured_at,
                "host": "fake-host", "server_root": "/opt/minecraft/server",
                "region_dir": str(region_dir), "region_files": len(regions),
                "nonempty_regions": len(regions), "level_dat_bytes": len(level_dat),
                "missing_sources": "", "console": "fake-console"}
    (capture / "manifest.json").write_text(json.dumps(manifest, indent=2))
    if zones is not None:
        (capture / "map-zones.json").write_text(json.dumps(zones, indent=2))
    for name, value in (config or {}).items():
        target = capture / "config" / name
        target.write_text(value if isinstance(value, str) else json.dumps(value))
    if positions is not None:
        (capture / "positions.json").write_text(json.dumps(positions, indent=2))

    tar_path = destination / "world-snapshot.tar.gz"
    with tarfile.open(tar_path, "w:gz") as archive:
        archive.add(root / "world", arcname="world")
        archive.add(capture, arcname="capture")
    payload = tar_path.read_bytes()
    sidecar = {
        "schema": 1, "captured_at": captured_at, "instance_id": instance_id,
        "tar_key": contract.SNAPSHOT_KEY, "tar_sha256": hashlib.sha256(payload).hexdigest(),
        "tar_bytes": len(payload), "region_files": len(regions),
        "nonempty_regions": len(regions), "level_dat_bytes": len(level_dat), "warnings": "",
    }
    return tar_path, sidecar


def zone_document():
    """A two-region zone document of the shape `core/map_zones.py` writes."""
    return {"schema": 1, "revision": 7, "zones": [
        {"id": "region-aaaa1111", "name": "North Beach", "short_name": "NB",
         "points": [[0, 0], [40, 0], [40, 40], [0, 40]],
         "pvp_protection": True, "pve_protection": True, "edit_protection": True,
         "navy_controlled": True, "guard_patrols": False, "navy_patrols": False},
        {"id": "region-bbbb2222", "name": "Harbour", "short_name": "HB",
         "points": [[10, 10], [20, 10], [20, 20], [10, 20]],
         "pvp_protection": False, "pve_protection": True, "edit_protection": True,
         "navy_controlled": False, "guard_patrols": True, "navy_patrols": True},
    ]}


def positions_store():
    """A last-known position store in the shape `core/minecraft_map_data.py` writes."""
    return {}


def published_document(repo_root=REPO_ROOT):
    return json.loads((Path(repo_root) / "site/data/world.json").read_text(encoding="utf8"))


def published_client(repo_root=REPO_ROOT):
    return json.loads((Path(repo_root) / "site/data/client.json").read_text(encoding="utf8"))


def make_repo(destination, source=REPO_ROOT):
    """A throwaway copy of the published tree, so a test never edits the checkout."""
    import shutil

    destination = Path(destination) / "repo"
    destination.mkdir(parents=True, exist_ok=True)
    for relative in ("site/data", "site/downloads", "desktop", "deployment.json"):
        source_path = Path(source) / relative
        target = destination / relative
        if source_path.is_dir():
            shutil.copytree(source_path, target)
        elif source_path.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, target)
    return destination


def png_tile(payload=b"tile"):
    """A tile the site validator accepts: PNG magic, and a version that is its own hash."""
    return b"\x89PNG\r\n\x1a\n" + payload
