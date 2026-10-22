"""Fetch the publish bundle, verify it, and unzip it into the checkout.

Two objects, over plain HTTPS, with no credential: `publish/latest.json` says what is ready,
and the zip beside it carries the bytes. Nothing here renders, and nothing here talks to AWS
-- that is the whole shape of the split, because GitHub OIDC is denied in this account and a
scheduled workflow therefore cannot hold an AWS credential (measured 2026-10-22:
`iam:CreateOpenIDConnectProvider` refused by an organisation SCP).

Three refusals shape this module:

* **A document from the wrong shape is refused**, not repaired: its key set is the contract
  between two repositories, and a change on either side must be a change to both.
* **A zip that does not hash to what the document says is refused** before a single member is
  extracted, and its members must be generated paths (`data/`, `downloads/`) with no traversal.
* **An older bundle is refused.** The set of halves has to be newer than what the checkout
  already publishes, so a stale `publish/latest.json` (a bucket restored from a backup, say)
  cannot walk the site backwards. `snapshot_day` is the map half's clock and is compared as a
  date; a client-only bundle carries no day, so it is allowed through only when its client
  document actually differs.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import io
import json
from pathlib import Path
import urllib.error
import urllib.request
import zipfile

from . import contract


class BundleError(RuntimeError):
    """The bundle cannot be fetched or trusted; nothing is committed."""


@dataclass
class MapHalf:
    document: dict          # the world document, as published
    tiles: dict             # {'data/tiles/x/z.png': bytes}
    snapshot_day: str
    digest: str

    @property
    def paths(self):
        return [contract.ZIP_WORLD] + sorted(self.tiles)


@dataclass
class ClientHalf:
    document: dict
    files: dict             # {'downloads/name.jar': bytes}
    digests: list = field(default_factory=list)


@dataclass
class Bundle:
    taken_at: str
    snapshot_day: str | None
    captured_at: str
    map: MapHalf | None
    client: ClientHalf | None
    zip_sha256: str = ""
    note: str = ""

    def halves(self):
        return [name for name, half in (("map", self.map), ("client", self.client)) if half]


def _get(url, timeout, limit=64 * 1024 * 1024):
    request = urllib.request.Request(url, headers={"User-Agent": "easter-co-atlas-publisher"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            length = response.headers.get("Content-Length")
            declared = int(length) if length and length.isdigit() else None
            chunks, total = [], 0
            while True:
                block = response.read(1024 * 256)
                if not block:
                    break
                total += len(block)
                if total > limit:
                    raise BundleError(f"{url} is larger than {limit} bytes; refusing it")
                chunks.append(block)
    except urllib.error.HTTPError as error:
        raise BundleError(f"GET {url} -> HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise BundleError(f"GET {url} -> {error.reason}") from error
    body = b"".join(chunks)
    if declared is not None and declared != len(body):
        raise BundleError(f"{url} is {len(body)} bytes but Content-Length said {declared}")
    return body


def fetch_document(settings, log=print):
    """`publish/latest.json`, refused unless it has exactly the contract's shape."""
    body = _get(settings.publish_url, settings.timeout_seconds)
    try:
        document = json.loads(body.decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BundleError(f"the publish document is not JSON: {error}") from error
    if set(document) != contract.PUBLISH_KEYS:
        raise BundleError("the publish document has fields outside the contract: "
                          f"{sorted(set(document) ^ contract.PUBLISH_KEYS)}")
    if document.get("schema") != contract.SCHEMA:
        raise BundleError(f"unsupported publish document schema {document.get('schema')!r}")
    for name, keys in (("map", contract.MAP_KEYS), ("client", contract.CLIENT_HALF_KEYS)):
        half = document.get(name)
        if half is not None and set(half) != keys:
            raise BundleError(f"the {name} half has fields outside the contract: "
                              f"{sorted(set(half) ^ keys)}")
    if document["map"] is None and document["client"] is None:
        raise BundleError("the publish document carries neither half; there is nothing to do, "
                          "but a bundle that says so is a bug upstream")
    log(f"atlas: publish document fetched: takenAt {document['takenAt']}, map "
        f"{'present' if document['map'] else 'absent'}, client "
        f"{'present' if document['client'] else 'absent'}")
    return document


def _safe_members(archive):
    problems = []
    for name in archive.namelist():
        parts = Path(name).parts
        if name.startswith("/") or ".." in parts:
            problems.append(f"{name} (absolute or traversing)")
        elif not (name.startswith("data/") or name.startswith("downloads/")):
            problems.append(f"{name} (not a generated path)")
    if problems:
        raise BundleError("refusing the bundle: " + "; ".join(problems[:5]))


def open_zip(zip_url, expected_sha256, expected_bytes, timeout, log=print):
    """Download one zip and verify it before anything is unpacked."""
    body = _get(zip_url, timeout)
    if expected_bytes and len(body) != int(expected_bytes):
        raise BundleError(f"the bundle is {len(body)} bytes but the document says "
                          f"{expected_bytes}")
    digest = hashlib.sha256(body).hexdigest()
    if digest != expected_sha256:
        raise BundleError(f"the bundle hashes to {digest} but the document says "
                          f"{expected_sha256}")
    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile as error:
        raise BundleError(f"the bundle is not a readable zip: {error}") from error
    _safe_members(archive)
    log(f"atlas: bundle verified: {len(body)} bytes sha256 {digest}")
    return archive


def read(settings, log=print):
    """The document and whichever halves it points at, verified."""
    document = fetch_document(settings, log=log)
    taken = document["takenAt"]
    map_half = client_half = None
    zip_sha = ""
    if document["map"] is not None or document["client"] is not None:
        # Both halves travel in one zip, and each half's row names it: a client-only bundle has
        # no map row, so the client row carries the same three fields.
        row = document["map"] or document["client"]
        zip_key = row.get("zip") or f"publish/tiles-{taken}.zip"
        zip_url = settings.publish_url.rsplit("/", 1)[0] + "/" + zip_key.rsplit("/", 1)[-1]
        expected_sha = row.get("sha256", "")
        expected_bytes = row.get("bytes", 0)
        if not expected_sha:
            raise BundleError("the publish document names a zip without a sha256; refusing it")
        archive = open_zip(zip_url, expected_sha, expected_bytes, settings.timeout_seconds,
                           log=log)
        zip_sha = expected_sha
        if document["map"] is not None:
            world_bytes = archive.read(contract.ZIP_WORLD)
            if hashlib.sha256(world_bytes).hexdigest() != document["map"]["world_sha256"]:
                raise BundleError("the world document in the bundle does not hash to what the "
                                  "publish document says")
            world = json.loads(world_bytes.decode("utf8"))
            tiles = {name: archive.read(name) for name in archive.namelist()
                     if name.startswith(contract.ZIP_TILES + "/") and name.endswith(".png")}
            map_half = MapHalf(document=world, tiles=tiles,
                               snapshot_day=str(world.get("snapshot_day") or ""),
                               digest=document["map"]["world_sha256"])
            log(f"atlas: the map half carries {len(tiles)} tile(s) for "
                f"snapshot_day {map_half.snapshot_day}")
        if document["client"] is not None:
            if contract.ZIP_CLIENT not in archive.namelist():
                raise BundleError("the publish document says a client half travels, but the "
                                  "bundle has no data/client.json")
            client_document = json.loads(archive.read(contract.ZIP_CLIENT).decode("utf8"))
            files = {row["path"]: archive.read(row["path"])
                     for row in document["client"]["files"]}
            for row in document["client"]["files"]:
                blob = files[row["path"]]
                if hashlib.sha256(blob).hexdigest() != row["sha256"]:
                    raise BundleError(f"{row['path']} does not hash to the document's sha256")
            client_half = ClientHalf(document=client_document, files=files,
                                     digests=[row["sha256"] for row in
                                              document["client"]["files"]])
            log(f"atlas: the client half carries {len(files)} file(s) for Minecraft "
                f"{client_document.get('minecraft')}")
    return Bundle(taken_at=taken, snapshot_day=(map_half.snapshot_day if map_half else None),
                  captured_at=document.get("captured_at"), map=map_half, client=client_half,
                  zip_sha256=zip_sha)


def published_day(repo_root):
    """The `snapshot_day` the checkout currently serves, or None."""
    try:
        document = json.loads((Path(repo_root) / "site/data/world.json").read_text("utf8"))
    except (OSError, ValueError):
        return None
    return document.get("snapshot_day")


def published_client_digest(repo_root):
    """A digest of the client half the checkout currently serves."""
    root = Path(repo_root)
    digest = hashlib.sha256()
    for path in (root / "site/data/client.json",):
        if path.is_file():
            digest.update(path.read_bytes())
    downloads = root / "site/downloads"
    if downloads.is_dir():
        for path in sorted(downloads.iterdir()):
            if path.is_file():
                digest.update(path.name.encode("utf8"))
                digest.update(path.read_bytes())
    return digest.hexdigest()


def is_newer(bundle, repo_root):
    """Would committing this bundle change what the site serves?

    The map half is compared by `snapshot_day`, the day the capture describes: a bundle whose
    day is not later than the published one is refused rather than committed, because
    walking the map backwards is never what a scheduled run means. The client half is
    compared by content, because it has no clock of its own.
    """
    wants_map = bundle.map is not None
    wants_client = bundle.client is not None
    current_day = published_day(repo_root)
    if wants_map:
        if not bundle.snapshot_day:
            raise BundleError("the bundle's map half has no snapshot_day; refusing it")
        if current_day is not None and bundle.snapshot_day <= current_day:
            return False, (f"the published map already carries snapshot_day {current_day}, "
                           f"which is not older than this bundle's {bundle.snapshot_day}")
    if wants_client:
        digest = hashlib.sha256()
        for row in sorted(bundle.client.files):
            digest.update(row.encode("utf8"))
            digest.update(bundle.client.files[row])
        digest.update(json.dumps(bundle.client.document, sort_keys=True).encode("utf8"))
        if digest.hexdigest() == published_client_digest(repo_root) and not wants_map:
            return False, "the published client half already carries these bytes"
    return True, ""


def apply(bundle, repo_root, log=print, only=None):
    """Write the bundle's halves into the checkout, and only their own generated paths.

    `only` restricts it to one half, which is what makes the two commits independent: the
    client half's commit can never carry a map path, or the other way round.
    """
    repo_root = Path(repo_root)
    written = []
    if bundle.map is not None and only in (None, "map"):
        target = repo_root / "site/data/world.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(json.dumps(bundle.map.document, ensure_ascii=False, indent=2,
                                      sort_keys=True).encode("utf8") + b"\n")
        written.append("site/data/world.json")
        tiles = repo_root / "site/data/tiles"
        keep = set()
        for member, blob in bundle.map.tiles.items():
            relative = member[len(contract.ZIP_TILES) + 1:]
            path = tiles / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
            keep.add(path.resolve())
            written.append(f"site/data/tiles/{relative}")
        if tiles.is_dir():
            for stale in sorted(tiles.rglob("*.png")):
                if stale.resolve() not in keep:
                    stale.unlink()
                    log(f"atlas: removed a stale tile the bundle no longer carries: "
                        f"{stale.relative_to(repo_root)}")
    if bundle.client is not None and only in (None, "client"):
        target = repo_root / "site/data/client.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(json.dumps(bundle.client.document, ensure_ascii=False, indent=2,
                                      sort_keys=True).encode("utf8") + b"\n")
        written.append("site/data/client.json")
        for member, blob in bundle.client.files.items():
            path = repo_root / "site" / member
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
            written.append(f"site/{member}")
    log(f"atlas: applied {len(written)} path(s) from the bundle")
    return written
