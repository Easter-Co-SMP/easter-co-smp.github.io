"""The client half: `site/data/client.json` and `site/downloads/`, published on its own.

This half has nothing to do with the world, and it publishes first, in its own failure
domain, because on 2026-10-19 the publisher died at the map capture and froze the client
manifest with it: no mod could reach a player for three days. Its commit is its own.

**What it rebuilds, and what it deliberately does not.** The manifest document is rebuilt
here with the exporter's own helpers (`packages`, `resolved_pins`, `resolve_dependencies`,
`resolved_graphics`, `resolved_graphics_companions`, `chunk_version`) so there is one set of
rules for what a client manifest is. What it does *not* do is rebuild the custom mod jar:
`export_world.export_client` builds that from `/opt/minecraft/client-mods`, which is a
directory on Owen's machine, and the whole point of this pipeline is that nothing needs that
machine. The jar that is published is the one already in `site/downloads/`, verified against
the checksum the published manifest states; a jar that disagrees is a refusal, not a
publication. Consequence, stated plainly: **a new mod jar still has to be built and placed in
`site/downloads/` by the launcher's own release path**; the hourly run then republishes the
manifest around it. That boundary is named in `doc/atlas-pipeline.md` rather than hidden.

The dependency rows, by contrast, *are* rebuilt: their pinned versions come from
`DEPENDENCIES` in `scripts/export_world.py` and their published files are confirmed against
Modrinth. So when somebody bumps a pin, the next run publishes it -- which is exactly the
case the old timer existed for.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

from scripts.export_world import (DEPENDENCIES, GRAPHICS_COMPANIONS, GRAPHICS_LOADER_NAME,
                                 GRAPHICS_PACK_VERSION, GRAPHICS_PATH_PREFIX, PublishedClientArtifacts,
                                 chunk_version, deployment_metadata, ensure_state_writable,
                                 graphics_resolver, modrinth_resolver, packages,
                                 read_resolution_state, resolve_dependencies, resolved_graphics,
                                 resolved_graphics_companions, resolved_pins, visual_files,
                                 write_json)

#: Where this half writes, relative to a staging directory, and the published path it
#: replaces. Both are inside `scripts/sync.py`'s generated tree.
CLIENT_OUTPUTS = (("data/client.json", "site/data/client.json"),
                  ("downloads", "site/downloads"))

#: The one file this half will not regenerate, only verify and republish.
OWNED_JAR = "easter-navy.jar"


class ClientError(RuntimeError):
    """The client half could not be built; the map half is unaffected."""


@dataclass
class ClientResult:
    document: dict
    staged: list          # (staged relative path, published path)
    changed: list         # published paths whose bytes actually differ
    note: str = ""

    @property
    def has_changes(self):
        return bool(self.changed)


def _published(repo_root):
    try:
        return json.loads((Path(repo_root) / "site/data/client.json").read_text(encoding="utf8"))
    except (OSError, ValueError) as error:
        raise ClientError(f"the published client manifest cannot be read: {error}") from error


def owned_mod(repo_root, published):
    """The jar we host, verified against the checksum the published manifest states."""
    jar = Path(repo_root) / "site/downloads" / OWNED_JAR
    if not jar.is_file():
        raise ClientError(f"the published custom mod {jar} is missing; the manifest names it")
    digest = hashlib.sha256(jar.read_bytes()).hexdigest()
    stated = (published.get("mod") or {}).get("sha256")
    if stated and digest != stated:
        raise ClientError(
            f"{jar.name} hashes to {digest} but the published manifest states {stated}. "
            "This half republishes the manifest around the jar it already distributes; it "
            "will not describe a jar nobody verified. Build and publish the jar through the "
            "launcher release path first.")
    size = jar.stat().st_size
    mod = dict(published["mod"], sha256=digest, bytes=size)
    return mod, {'name': mod['name'], 'version': mod['version'],
                 'path': f'downloads/{OWNED_JAR}', 'url': f'downloads/{OWNED_JAR}',
                 'hash': 'sha256:' + digest, 'size': size}


def build_document(repo_root, staging, resolver=None, graphics=None, now=None, log=print):
    """Rebuild `client.json` from the checkout's artifacts and the current pins."""
    repo_root, staging = Path(repo_root), Path(staging)
    staging.mkdir(parents=True, exist_ok=True)
    published = _published(repo_root)
    mod, custom_file = owned_mod(repo_root, published)
    destination = staging / "downloads"
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(repo_root / "site/downloads" / OWNED_JAR, destination / OWNED_JAR)

    minecraft = published["minecraft"]
    # The published dependency rows are the authority for each dependency's display name AND
    # its pinned version: those pins are properties of the mod jars the launcher ships, which
    # live in the release tree, not in this repository. `DEPENDENCIES` supplies the project
    # URL only. So this half re-confirms what upstream publishes behind each pin; it cannot
    # invent a new pin, and a pin that no longer resolves is a refusal.
    rows = {row["id"]: row for row in published.get("dependencies") or []}
    published_files = {entry["id"]: entry
                       for chunk in published.get("chunks") or []
                       for entry in chunk.get("files") or []}
    entries, display = {}, {}
    for ident in DEPENDENCIES:
        row = rows.get(ident)
        if row is None or not row.get("version"):
            raise ClientError(f"the published manifest has no pinned version for {ident}; "
                              "refusing to publish a dependency list with a hole in it")
        # `resolve_dependencies` uses an entry's `name` as the published FILE name, while the
        # dependency row and the launcher's own UI use the project's display name. Keep both:
        # the file name comes from the published manifest, the display name is restored onto
        # the chunk entries below, so republishing never renames a dependency in the launcher.
        stated = published_files.get(ident) or {}
        entries[ident] = {"name": stated.get("path") or stated.get("name") or ident,
                          "version": row["version"]}
        display[ident] = row.get("name") or ident
    state_path = ensure_state_writable(staging / "modrinth.json")
    state = read_resolution_state(state_path)
    files = resolve_dependencies(resolver if resolver is not None else modrinth_resolver(),
                                entries, minecraft, state, now=now)
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf8")

    pins = resolved_pins(repo_root, {'minecraft': minecraft})
    if published.get("fabric") and published["fabric"] != pins["fabric"]:
        raise ClientError(
            f"the launcher installs Fabric {pins['fabric']} but the published manifest says "
            f"{published['fabric']}; refusing to publish two pins for one client")
    pack = resolved_graphics(graphics if graphics is not None else graphics_resolver(),
                             minecraft, staging / "graphics.json")
    companions = resolved_graphics_companions(
        graphics if graphics is not None else graphics_resolver(), minecraft,
        staging / "graphics-companions.json")
    client = {
        "deployment": deployment_metadata(),
        "minecraft": minecraft,
        "fabric": pins["fabric"],
        "mod": mod,
        "dependencies": [{"id": ident, "name": display[ident], "version": entry["version"],
                          "url": DEPENDENCIES[ident]} for ident, entry in entries.items()],
        "chunks": packages(custom_file, {"mods": files}, pins, pack, companions,
                           visual_files(minecraft)),
    }
    for chunk in client["chunks"]:
        for entry in chunk["files"]:
            if entry["id"] in display and published_files.get(entry["id"], {}).get("name"):
                entry["name"] = published_files[entry["id"]]["name"]
        chunk["version"] = chunk_version(chunk)
        if chunk["version"] != chunk_version(chunk):
            raise ClientError(f"chunk {chunk['id']} is not the digest of its files")
        for entry in chunk["files"]:
            path = entry["path"]
            if path.startswith("/") or ":" in path or "\\" in path:
                raise ClientError(f"refusing to publish a non-relative file path: {path}")
    write_json(staging / "data/client.json", client)
    log(f"atlas: staged client manifest for Minecraft {minecraft} / Fabric {pins['fabric']} "
        f"with {len(client['chunks'])} chunk(s) and {len(client['dependencies'])} "
        f"dependency pin(s)")
    return client


def compare(staging, repo_root):
    """Which published paths would actually change. Byte comparison, not a path list."""
    staging, repo_root = Path(staging), Path(repo_root)
    changed, staged = [], []
    for staged_name, published_name in CLIENT_OUTPUTS:
        source = staging / staged_name
        if not source.exists():
            raise ClientError(f"the staged client half is missing {staged_name}")
        staged.append((staged_name, published_name))
        target = repo_root / published_name
        if source.is_dir():
            for path in sorted(source.rglob("*")):
                if not path.is_file():
                    continue
                relative = path.relative_to(source)
                other = target / relative
                if not other.is_file() or other.read_bytes() != path.read_bytes():
                    changed.append(f"{published_name}/{relative.as_posix()}")
        elif not target.is_file() or target.read_bytes() != source.read_bytes():
            changed.append(published_name)
    return staged, changed


def publish_files(staging, repo_root, staged):
    """Copy the staged half over the checkout, and only that half's paths."""
    staging, repo_root = Path(staging), Path(repo_root)
    for staged_name, published_name in staged:
        source, target = staging / staged_name, repo_root / published_name
        if source.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(source, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    return [published_name for _staged, published_name in staged]


def build(repo_root, staging, resolver=None, graphics=None, log=print):
    """Stage and compare; applies nothing, so a caller can validate before publishing."""
    document = build_document(repo_root, staging, resolver=resolver, graphics=graphics, log=log)
    staged, changed = compare(staging, repo_root)
    result = ClientResult(document=document, staged=staged, changed=changed)
    if not changed:
        result.note = "the published client half is already current"
    else:
        log(f"atlas: client half changes {len(changed)} published path(s): "
            + ", ".join(changed[:6]) + (" ..." if len(changed) > 6 else ""))
    return result
