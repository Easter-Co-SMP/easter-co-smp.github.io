"""Everything the pipeline reads from its environment, in one place.

The workflow sets these; a developer or a test sets the same names. Nothing here is a
secret: the AWS credentials arrive through GitHub OIDC and the GitHub token is the
workflow's own, so this module carries names and bounds, never values that must be hidden.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path

from . import contract


class ConfigError(ValueError):
    """A required setting is missing or unusable: fail before doing any work."""


def _int(environ, name, default):
    raw = environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ConfigError(f"{name}={raw!r} is not an integer") from error
    if value < 1:
        raise ConfigError(f"{name}={value} must be at least 1")
    return value


@dataclass(frozen=True)
class Settings:
    """One immutable settings object, built once and passed down."""

    bucket: str
    instance_id: str
    region: str
    snapshot_key: str
    sidecar_key: str
    pointer_key: str
    repo_root: Path
    render_workers: int
    ready_timeout_seconds: int
    snapshot_timeout_seconds: int
    start_timeout_seconds: int
    marker_policy: str
    #: How to reach the server console on the host. The one host fact this repository cannot
    #: know; see `scripts/atlas/host/snapshot.sh`.
    console_command: str
    server_unit: str
    log_path: str

    @classmethod
    def from_env(cls, environ=None, repo_root=None):
        environ = os.environ if environ is None else environ
        bucket = (environ.get("ATLAS_BUCKET") or "").strip()
        instance = (environ.get("ATLAS_INSTANCE_ID") or "").strip()
        if not bucket:
            raise ConfigError("ATLAS_BUCKET is required (the atlas bucket's name)")
        marker_policy = (environ.get("ATLAS_MARKERS") or "carry").strip().lower()
        if marker_policy not in ("carry", "refuse"):
            raise ConfigError("ATLAS_MARKERS must be 'carry' or 'refuse'")
        root = Path(repo_root or environ.get("ATLAS_REPO_ROOT")
                    or Path(__file__).resolve().parents[2]).resolve()
        return cls(
            bucket=bucket,
            instance_id=instance,
            region=(environ.get("AWS_REGION") or environ.get("ATLAS_REGION") or "us-east-2").strip(),
            snapshot_key=(environ.get("ATLAS_SNAPSHOT_KEY") or contract.SNAPSHOT_KEY).strip(),
            sidecar_key=(environ.get("ATLAS_SIDECAR_KEY") or contract.SIDECAR_KEY).strip(),
            pointer_key=(environ.get("ATLAS_POINTER_KEY") or contract.POINTER_KEY).strip(),
            repo_root=root,
            render_workers=_int(environ, "ATLAS_RENDER_WORKERS",
                                min(4, os.cpu_count() or 1)),
            ready_timeout_seconds=_int(environ, "ATLAS_READY_TIMEOUT", 900),
            snapshot_timeout_seconds=_int(environ, "ATLAS_SNAPSHOT_TIMEOUT", 1800),
            start_timeout_seconds=_int(environ, "ATLAS_START_TIMEOUT", 300),
            marker_policy=marker_policy,
            console_command=(environ.get("ATLAS_CONSOLE") or "minecraft-console").strip(),
            server_unit=(environ.get("ATLAS_SERVER_UNIT") or "minecraft.service").strip(),
            log_path=(environ.get("ATLAS_SERVER_LOG")
                      or "/opt/minecraft/server/logs/latest.log").strip(),
        )

    def require_instance(self):
        """Change detection needs the instance; the client half does not."""
        if not self.instance_id:
            raise ConfigError("ATLAS_INSTANCE_ID is required to ask EC2 whether the world changed")
        return self.instance_id
