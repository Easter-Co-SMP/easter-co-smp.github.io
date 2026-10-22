"""`python -m scripts.atlas` -- what `.github/workflows/atlas.yml` runs."""
from __future__ import annotations

import sys

from scripts.atlas.cli import main

if __name__ == "__main__":
    sys.exit(main())
