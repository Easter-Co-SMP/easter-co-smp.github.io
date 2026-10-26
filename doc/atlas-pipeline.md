# The atlas pipeline: the public map without Owen's machine

The map used to be rendered and published by a systemd timer on Easter-Server. Owen's rule is
that his personal computer cannot be part of production infrastructure, so the timer is disabled
(2026-10-22) and this replaces it.

**It is two halves in two repositories, and neither holds a credential for the other:**

| half | where | what it does |
|---|---|---|
| AWS | `easter-co-cloud/pipeline/atlas/` (a scheduled Lambda) | decides whether the world changed, wakes the host, captures, **stops the host**, renders the tiles, writes the publish bundle |
| site | here: `scripts/atlas/` + `.github/workflows/atlas.yml` | reads `publish/latest.json` over plain HTTPS, verifies it, commits each half with its own `GITHUB_TOKEN` |

The direction is forced, not chosen: **GitHub OIDC is denied in this AWS account** (measured
2026-10-22 — `iam:GetOpenIDConnectProvider`, `iam:ListOpenIDConnectProviders` and
`iam:CreateOpenIDConnectProvider` are each refused by organisation SCP `o-yk9cqpb570` /
`p-vt1ibhxo`), so a workflow here cannot assume a role and must not hold AWS keys. AWS writes
bytes it is allowed to write; this workflow reads them over plain HTTPS, through one CloudFront
distribution whose bucket policy grants `s3:GetObject` on `publish/*` to `cloudfront.amazonaws.com`
and to nobody else — the account refuses a public bucket policy, so the prefix is reachable
rather than public (cloud `doc/ATLAS_PIPELINE.md`, "It used to be a **public** prefix"). The raw
world stays in the bucket's private `world/` prefix.

## What this half does, and does not

```
python -m scripts.atlas            # the workflow's whole command
```

1. **Fetch** `publish/latest.json` (`ATLAS_PUBLISH_URL`, a repository *variable*, not a secret).
   Its key set is the contract between the two repositories; anything else is refused.
2. **Refuse a stale bundle.** If its `snapshot_day` is not later than the day `site/data/world.json`
   already carries, print exactly one line naming the published day and the comparison, commit
   nothing, and leave `site/data/world.json` byte for byte unchanged. Nothing here ever records a
   fresher capture than the snapshot it came from.
3. **Verify the zip** — its sha256 and byte count against the document, the world document
   against its own hash, every member a generated path (`data/`, `downloads/`), no traversal —
   before writing anything.
4. **Commit each half on its own**, client first: `site/data/client.json` + `site/downloads/` is
   one commit, `site/data/world.json` + `site/data/tiles/` is another. From 2026-10-19 to
   2026-10-22 a dead map capture froze the client manifest for three days, so the client half
   can never sit behind the map half's success. Either half may be absent from a bundle.

Publishing is the Git Data API (`scripts/atlas/publish.py`): a blob is uploaded only when its git
blob hash is not already in the tree, one half is one commit, and the ref is fast-forwarded,
never forced. Any path outside `site/data` and `site/downloads` is refused before a request is
made.

## What is proven, and what is not

**Proven here:**

* the thin committer end to end against a real HTTP server serving real bundles
  (`tests/test_atlas_bundle.py`, 13 tests): the one-line reuse path with `world.json` unchanged,
  a newer bundle committed as one map commit, a client-only bundle committed alone, a bundle
  carrying both halves as two commits, a client failure that does not stop the map half, and
  refusals for a bad zip hash, a mismatched world document, a member outside the generated
  paths, a traversing member, a document of the wrong shape, a document with neither half, an
  unreachable URL, and a config without a token or with a plain-`http` URL.
* the publisher over real HTTP against a local server speaking the Git Data API
  (`tests/test_atlas_publish.py`): blobs reused by content, one commit per half, path refusals
  before any request, a retried 422 that never forces the ref.
* the workflow's shape: exactly one permission (`contents: write`), cron + dispatch, one
  non-cancellable concurrency group, no secret expression, no AWS action, and actionlint clean.

**Not proven:** the wire to a real bucket. No object has been fetched from S3, and no commit has
been made by this code. `ATLAS_PUBLISH_URL` has to be set once (the public URL of
`publish/latest.json`) and the first scheduled run is the proof.

## The bundle contract (what the AWS half must write)

```json
{"schema": 1, "takenAt": "20261023T043000Z", "snapshot_day": "2026-10-23",
 "captured_at": "2026-10-23T04:30:00+00:00",
 "map": {"zip": "publish/tiles-20261023T043000Z.zip", "sha256": "…", "bytes": 12345,
         "world_sha256": "…", "world_bytes": 9999, "tiles": 66},
 "client": {"document": {...}, "files": [{"path": "downloads/easter-navy.jar", "sha256": "…",
                                         "bytes": 717642}], "zip": "…", "sha256": "…",
            "bytes": 12345}}
```

Neither half may be absent at the same time. The zip carries `data/world.json`, `data/tiles/**`
and, when a client half travels, `data/client.json` + `downloads/**`.
