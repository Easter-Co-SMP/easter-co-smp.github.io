"""The Git Data API in memory: enough to count commits and inspect what each one changed.

The HTTP surface is exercised for real in `tests/test_atlas_publish.py`; this fake is for the
tests whose subject is the *decision* (one commit per half, nothing on a reused snapshot), not
the transport.
"""
from __future__ import annotations

import hashlib


def blob_sha(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode("ascii") + data).hexdigest()


class RecordingGitHub:
    def __init__(self, files=None):
        self.trees = {"tree-0": dict(files or {})}
        self.head = "commit-0"
        self.commits = []
        self.blobs = {}
        self.calls = []
        self.force_seen = []
        self._counter = 0

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
        previous = dict(self.trees.get("tree-0", {}))
        changed = sorted(path for path, digest in files.items() if previous.get(path) != digest)
        changed += sorted(path for path in previous if path not in files)
        self.commits.append({"sha": sha, "message": message, "tree": tree,
                             "files": files, "changed": changed, "parents": list(parents)})
        return sha

    def fast_forward(self, sha, branch="main"):
        self.calls.append("fast_forward")
        self.force_seen.append(False)
        self.head = sha
        self.trees["tree-0"] = dict(self.commits[-1]["files"])
        return {}
