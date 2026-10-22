"""`python -m scripts.atlas` -- the entry point the workflow runs."""
from __future__ import annotations

import sys

from scripts.atlas.cli import main

if __name__ == "__main__":
    sys.exit(main())
