"""The four settings this half reads, and nothing secret in any of them."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


class ConfigError(ValueError):
    """A required setting is missing: fail before doing any work."""


@dataclass(frozen=True)
class Settings:
    #: The public URL of `publish/latest.json`. No credential: the object is public, and it
    #: carries only the document and tiles the site already serves.
    publish_url: str
    #: owner/repo for the Git Data API. The workflow provides it as GITHUB_REPOSITORY.
    repository: str
    github_token: str
    repo_root: Path
    branch: str = "main"
    #: How many objects the fetch may download (the document plus one zip).
    timeout_seconds: int = 60

    @classmethod
    def from_env(cls, environ=None, repo_root=None):
        environ = os.environ if environ is None else environ
        url = (environ.get("ATLAS_PUBLISH_URL") or "").strip()
        if not url:
            raise ConfigError("ATLAS_PUBLISH_URL is required (the public URL of "
                              "publish/latest.json)")
        if not url.startswith("https://"):
            raise ConfigError(f"ATLAS_PUBLISH_URL must be https, not {url!r}")
        repository = (environ.get("GITHUB_REPOSITORY") or "").strip()
        if repository.count("/") != 1:
            raise ConfigError("GITHUB_REPOSITORY must be owner/repo")
        token = (environ.get("ATLAS_GITHUB_TOKEN") or "").strip()
        if not token:
            raise ConfigError("ATLAS_GITHUB_TOKEN is required (the workflow's own token)")
        root = Path(repo_root or environ.get("ATLAS_REPO_ROOT")
                    or Path(__file__).resolve().parents[2]).resolve()
        return cls(publish_url=url, repository=repository, github_token=token,
                   repo_root=root,
                   branch=(environ.get("ATLAS_BRANCH") or "main").strip())
