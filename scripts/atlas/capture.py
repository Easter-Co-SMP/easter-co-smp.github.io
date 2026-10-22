"""Open the snapshot the host uploaded: verify it, then extract it somewhere harmless.

The tarball arrives from the production server over a path the pipeline does not own, so
nothing about it is trusted:

* its bytes are hashed while they are streamed and compared with the sidecar's claim before
  a single member is extracted;
* extraction refuses absolute paths, `..` members, device files and links that leave the
  target, so a capture cannot write outside the temporary root;
* the world root and a server root are then presented as two directories the vendored
  renderer already understands (`world/`, `config/`), using symlinks so the snapshot itself
  stays byte-for-byte what the host uploaded.

What the pipeline does with an unverifiable capture is refuse. A render of the wrong bytes
is a public map that is quietly wrong, which is worse than an hour with no update.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile

from . import contract


class CaptureError(RuntimeError):
    """The snapshot cannot be trusted or cannot be opened."""


@dataclass
class Snapshot:
    """Where the pieces of a verified capture live on disk."""

    root: Path            # the extracted tarball, exactly as the host made it
    world_root: Path      # <root>/world, what the renderer renders
    server_root: Path     # a directory the marker reader reads: world/ + config/
    manifest: dict        # capture/manifest.json, the host's own record
    sidecar: dict         # what the host claimed about the bytes
    tar_path: Path
    tar_sha256: str
    cache_dir: Path       # where the marker reader finds the captured position store

    @property
    def region_dir(self):
        modern = self.world_root / contract.WORLD_REGION_DIR
        return modern if modern.is_dir() else self.world_root / "region"

    @property
    def captured_at(self):
        return self.manifest.get("captured_at") or self.sidecar.get("captured_at")

    def optional(self, relative):
        path = self.root / relative
        return path if path.exists() else None


def _safe_members(archive):
    """Refuse a member list that could escape the extraction root, before extracting."""
    problems = []
    for member in archive.getmembers():
        name = member.name
        if name.startswith("/") or name.startswith("\\") or ".." in Path(name).parts:
            problems.append(f"{name} (absolute or traversing)")
            continue
        if member.isdev() or member.isfifo():
            problems.append(f"{name} (device or fifo)")
            continue
        if member.issym() or member.islnk():
            target = Path(member.linkname)
            if target.is_absolute() or ".." in target.parts:
                problems.append(f"{name} -> {member.linkname} (link leaves the snapshot)")
    if problems:
        raise CaptureError("refusing the snapshot: " + "; ".join(problems[:5]))


def download(s3, settings, workdir, log=print):
    """Stream the snapshot to disk and check it against the sidecar."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        sidecar_body = s3.get_object(Bucket=settings.bucket, Key=settings.sidecar_key)["Body"].read()
    except Exception as error:  # noqa: BLE001
        raise CaptureError(f"cannot read the sidecar s3://{settings.bucket}/"
                           f"{settings.sidecar_key}: {error}") from error
    try:
        sidecar = json.loads(sidecar_body.decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CaptureError(f"the sidecar is not JSON: {error}") from error
    claimed_sha = str(sidecar.get("tar_sha256") or "")
    claimed_bytes = int(sidecar.get("tar_bytes") or 0)
    if not claimed_sha or claimed_bytes <= 0:
        raise CaptureError("the sidecar states no sha256 or no byte count; refusing to guess")

    tar_path = workdir / "world-snapshot.tar.gz"
    digest = hashlib.sha256()
    written = 0
    try:
        body = s3.get_object(Bucket=settings.bucket, Key=settings.snapshot_key)["Body"]
        with tar_path.open("wb") as stream:
            while True:
                block = body.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
                stream.write(block)
                written += len(block)
    except Exception as error:  # noqa: BLE001
        raise CaptureError(f"cannot download s3://{settings.bucket}/{settings.snapshot_key}: "
                           f"{error}") from error
    if written != claimed_bytes:
        raise CaptureError(f"the snapshot is {written} bytes but the sidecar claims "
                           f"{claimed_bytes}")
    if digest.hexdigest() != claimed_sha:
        raise CaptureError(f"the snapshot hashes to {digest.hexdigest()} but the sidecar "
                           f"claims {claimed_sha}")
    log(f"atlas: snapshot verified: {written} bytes sha256 {claimed_sha}")
    return tar_path, sidecar


def extract(tar_path, destination, log=print):
    """Extract a verified tarball into `destination`, refusing anything but plain members."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(tar_path, "r:gz") as archive:
            _safe_members(archive)
            # `filter="data"` is the standard library's own hardening on top of the member
            # check above (it also normalises modes and refuses absolute links).
            archive.extractall(destination, filter="data")
    except tarfile.TarError as error:
        raise CaptureError(f"the snapshot is not a readable tar.gz: {error}") from error
    log(f"atlas: extracted {tar_path.name} into {destination}")
    return destination


def open_snapshot(s3, settings, workdir, log=print):
    """Download, verify, extract and present the capture's two roots."""
    workdir = Path(workdir)
    tar_path, sidecar = download(s3, settings, workdir, log=log)
    root = extract(tar_path, workdir / "snapshot", log=log)
    world_root = root / contract.CAPTURE_WORLD
    if not (world_root / contract.WORLD_LEVEL_DAT).is_file() and not (
            world_root / contract.WORLD_REGION_DIR).is_dir():
        raise CaptureError(f"the snapshot has no world tree: expected "
                           f"{contract.CAPTURE_WORLD}/{contract.WORLD_LEVEL_DAT}")
    try:
        manifest = json.loads((root / contract.CAPTURE_MANIFEST).read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise CaptureError(f"the snapshot has no readable {contract.CAPTURE_MANIFEST}: "
                           f"{error}") from error
    if not manifest.get("captured_at"):
        raise CaptureError(f"{contract.CAPTURE_MANIFEST} does not say when the capture was taken")

    # The marker reader (`minecraft_map_data`) reads SERVER/world and SERVER/config, and its
    # last-known position store lives under CACHE. Present all three from the snapshot with
    # symlinks, so nothing is copied and the extracted tree stays exactly as uploaded.
    server_root = workdir / "server-root"
    server_root.mkdir(parents=True, exist_ok=True)
    _link(server_root / "world", world_root)
    config = root / contract.CAPTURE_CONFIG
    if config.is_dir():
        _link(server_root / "config", config)
    cache = workdir / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    positions = root / contract.CAPTURE_POSITIONS
    if positions.is_file():
        shutil.copyfile(positions, cache / "map-last-known.json")

    snapshot = Snapshot(root=root, world_root=world_root, server_root=server_root,
                        manifest=manifest, sidecar=sidecar, tar_path=tar_path,
                        tar_sha256=sidecar["tar_sha256"], cache_dir=cache)
    regions = sorted(p.name for p in snapshot.region_dir.glob("r.*.*.mca"))
    if not regions:
        raise CaptureError(f"the snapshot has no region files under {snapshot.region_dir}")
    log(f"atlas: capture {manifest.get('capture_id') or 'unnamed'} taken "
        f"{snapshot.captured_at} carries {len(regions)} region files"
        + ("" if positions.is_file() else ", no last-known position store"))
    return snapshot


def _link(link, target):
    if link.is_symlink() or link.exists():
        return
    os.symlink(target, link, target_is_directory=True)
