"""The site half of the atlas pipeline: fetch a publish bundle, commit it, and nothing else.

The AWS half captures and renders (it lives in `easter-co-cloud`, `pipeline/atlas/`); this
half notices that a new bundle exists and commits it with the workflow's own `GITHUB_TOKEN`.
GitHub OIDC is denied in this account, so the reverse arrangement -- a workflow that talks to
AWS -- is not available at all. See `doc/atlas-pipeline.md`.
"""
