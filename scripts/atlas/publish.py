"""Publish one half through the GitHub API, with the workflow's own token.

No PAT, no deploy key, no ssh key, no git binary, and nothing on any machine of Owen's: the
workflow's `GITHUB_TOKEN` (from `permissions: contents: write`) is the only credential, it
expires with the job, and there is nothing to rotate.

The commit is built through the Git Data API, which matters for a repository that carries
PNGs:

* a blob's identity is its content, so a tile whose bytes did not change is recognised by
  comparing the *local* git blob hash with the one already in the tree, and is never
  uploaded again;
* one commit per half is one `create tree` plus one `create commit`, so 66 tiles are a single
  commit and not 66 -- and a fast-forward `PATCH` of `refs/heads/main` means a parallel push
  is refused by GitHub rather than overwritten;
* the published tree is written only under this pipeline's generated paths. A path outside
  `site/data/` and `site/downloads/` is refused before a single request is made, and so is a
  deletion outside them.

Two properties the household has already paid for are encoded here: publishing only from
`main`, and never force-updating a ref.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import base64
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

from . import contract

API_ROOT = "https://api.github.com"


class PublishError(RuntimeError):
    """The half could not be committed. Nothing is left half-written."""


class RefusedPath(PublishError):
    """A path outside the generated tree was about to be published."""


@dataclass
class Half:
    """One publication: its published paths, its staged bytes and its commit message."""

    name: str
    paths: tuple
    staging: Path
    message: str
    #: Files that no longer exist and should be removed from the tree (tiles of regions that
    #: have gone empty), relative to the repository root.
    delete: tuple = ()

    def files(self):
        """(repository-relative path, absolute path with the bytes) for every file.

        `staging` mirrors the repository root, so a staged tree is read with exactly the
        paths that will be published -- there is no second path mapping to get wrong.
        """
        rows = []
        for published in self.paths:
            source = Path(self.staging) / published
            if source.is_dir():
                for path in sorted(source.rglob("*")):
                    if path.is_file():
                        rows.append((f"{published}/{path.relative_to(source).as_posix()}", path))
            elif source.is_file():
                rows.append((published, source))
            else:
                raise PublishError(f"the staged {self.name} half is missing {source}")
        return rows


@dataclass
class CommitResult:
    committed: bool
    sha: str | None = None
    path: str = ""
    uploaded: int = 0
    reused: int = 0
    deleted: int = 0
    note: str = ""
    attempts: int = 1
    messages: list = field(default_factory=list)

    @property
    def line(self):
        if not self.committed:
            return f"atlas: {self.path or 'publication'} committed nothing: {self.note}"
        return (f"atlas: {self.path} committed {self.sha[:12]} "
                f"({self.uploaded} new blob(s), {self.reused} unchanged, "
                f"{self.deleted} removed)")


def blob_sha(data):
    """Git's own blob identity: sha1 over 'blob <size>\\0' plus the bytes."""
    header = f"blob {len(data)}\0".encode("ascii")
    return hashlib.sha1(header + data).hexdigest()


class GitHubAPI:
    """The four Git Data endpoints this pipeline needs, and nothing else."""

    def __init__(self, token, repo, api_root=API_ROOT, timeout=60, log=print):
        if not token:
            raise PublishError("no GitHub token: the workflow's GITHUB_TOKEN is required")
        self.token = token
        self.repo = repo
        self.api_root = api_root.rstrip("/")
        self.timeout = timeout
        self.log = log
        self.calls = []

    # ── transport ────────────────────────────────────────────────────────────────────
    def _request(self, method, path, body=None):
        url = f"{self.api_root}{path}"
        data = None if body is None else json.dumps(body).encode("utf8")
        request = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "easter-co-atlas-pipeline",
            **({"Content-Type": "application/json"} if data is not None else {}),
        })
        self.calls.append((method, path))
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read()
        except urllib.error.HTTPError as error:
            try:
                detail = error.read().decode("utf8", "replace")[:400]
            finally:
                error.close()
            raise PublishError(f"{method} {path} -> HTTP {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise PublishError(f"{method} {path} -> {error.reason}") from error
        return json.loads(payload.decode("utf8")) if payload else {}

    def get(self, path):
        return self._request("GET", path)

    def post(self, path, body):
        return self._request("POST", path, body)

    def patch(self, path, body):
        return self._request("PATCH", path, body)

    # ── the pipeline's four calls ────────────────────────────────────────────────────
    def repository(self):
        return self.get(f"/repos/{self.repo}")

    def branch_head(self, branch="main"):
        ref = self.get(f"/repos/{self.repo}/git/ref/heads/{branch}")
        return ref["object"]["sha"]

    def commit_tree(self, sha):
        return self.get(f"/repos/{self.repo}/git/commits/{sha}")["tree"]["sha"]

    def tree(self, sha):
        return self.get(f"/repos/{self.repo}/git/trees/{sha}?recursive=1")

    def blob(self, data):
        payload = base64.b64encode(data).decode("ascii")
        return self.post(f"/repos/{self.repo}/git/blobs",
                         {"content": payload, "encoding": "base64"})["sha"]

    def create_tree(self, base_tree, entries):
        return self.post(f"/repos/{self.repo}/git/trees",
                         {"base_tree": base_tree, "tree": entries})["sha"]

    def create_commit(self, message, tree, parents):
        return self.post(f"/repos/{self.repo}/git/commits",
                         {"message": message, "tree": tree, "parents": parents})["sha"]

    def fast_forward(self, sha, branch="main"):
        return self.patch(f"/repos/{self.repo}/git/refs/heads/{branch}",
                          {"sha": sha, "force": False})


def ensure_generated(paths):
    """Refuse any path outside the generated tree this pipeline may write."""
    for path in paths:
        if not any(path == prefix or path.startswith(prefix + "/")
                   for prefix in contract.GENERATED_PATHS):
            raise RefusedPath(
                f"{path} is outside the generated tree {contract.GENERATED_PATHS}; this "
                "pipeline publishes generated data only")


def publish(api, half, branch="main", attempts=3, sleep=time.sleep, log=print):
    """Commit one half, or report that its bytes are already published. Never forces a ref."""
    files = half.files()
    ensure_generated([path for path, _source in files])
    ensure_generated(list(half.delete))
    if not files:
        raise PublishError(f"the {half.name} half has no files to publish")

    for attempt in range(1, attempts + 1):
        head = api.branch_head(branch)
        tree_sha = api.commit_tree(head)
        existing = {entry["path"]: entry for entry in api.tree(tree_sha).get("tree", [])}
        payloads = {path: source.read_bytes() for path, source in files}

        wanted, uploaded, reused = [], 0, 0
        for path, data in payloads.items():
            digest = blob_sha(data)
            current = existing.get(path)
            if current and current.get("sha") == digest and current.get("type") == "blob":
                reused += 1
                continue
            wanted.append({"path": path, "mode": "100644", "type": "blob",
                           "sha": api.blob(data)})
            uploaded += 1

        removals = []
        for path in half.delete:
            if path in existing:
                removals.append({"path": path, "mode": "100644", "type": "blob", "sha": None})

        if not wanted and not removals:
            log(f"atlas: {half.name} half: nothing changed; {reused} file(s) already match the "
                f"published tree at {head[:12]}")
            return CommitResult(committed=False, reused=reused, note="already published",
                                path=half.name, attempts=attempt)

        new_tree = api.create_tree(tree_sha, wanted + removals)
        commit = api.create_commit(half.message, new_tree, [head])
        try:
            api.fast_forward(commit, branch)
        except PublishError as error:
            if attempt >= attempts:
                raise
            # Somebody else moved main between our read and our write. Rebuild on top of the
            # new head rather than forcing anything; the next attempt re-uses unchanged blobs.
            log(f"atlas: {half.name} half: main moved while committing ({error}); retrying on "
                f"the new head (attempt {attempt + 1}/{attempts})")
            sleep(min(2 ** attempt, 10))
            continue
        result = CommitResult(committed=True, sha=commit, uploaded=uploaded, reused=reused,
                              deleted=len(removals), path=half.name, attempts=attempt)
        log(result.line)
        return result
    raise PublishError(f"the {half.name} half could not be committed after {attempts} attempts")
