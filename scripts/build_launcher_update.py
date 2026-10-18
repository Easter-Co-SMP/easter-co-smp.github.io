"""Build verified per-platform app-file update assets from the packaged application."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
from verify_app_bundle import parse_manifest, collect_files, read_member

root = Path(__file__).resolve().parents[1]
platform = sys.argv[1]
folder = {"linux": "linux-unpacked", "win32": "win-unpacked"}[platform]
archive = root / "release" / folder / "resources" / "app.asar"
header, base, raw = parse_manifest(archive)
members = dict(collect_files(header["files"]))
package = json.loads(read_member(raw, base, members["package.json"]))
expected = json.loads((root / "package.json").read_text())
assert package["version"] == expected["version"]
assert package["main"] == "desktop/bootstrap.cjs"
assert "desktop/bootstrap.cjs" in members and "desktop/updater.cjs" in members
# A single ASAR payload must be complete; native/unpacked extras need a new protocol.
assert not any(name.endswith(".node") for name in members), "Native dependencies require a runtime update"
assert package["name"] == "easter-company-launcher"
runtime = expected["devDependencies"]["electron"]
assert runtime[0].isdigit() and all(c in "0123456789." for c in runtime)
name = "Easter-Company-Update-" + platform + "-x64"
asset = name + ".asar"
shutil.copyfile(archive, root / "release" / asset)
manifest = dict(schema=1, bootstrap=1, version=package["version"], platform=platform,
                arch="x64", runtime=runtime, asset=asset, size=len(raw),
                sha256=hashlib.sha256(raw).hexdigest())
(root / "release" / (name + ".json")).write_text(json.dumps(manifest, indent=2) + "\n")
print("Verified launcher app-file payload:", asset, manifest["sha256"])
