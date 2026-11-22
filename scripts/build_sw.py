#!/usr/bin/env python3
"""Stamp the site-wide service worker with a build id and its precache list.

    python3 scripts/build_sw.py _site "$GITHUB_SHA"   # deploy: rewrites _site/sw.js

serve.py imports render_sw() to do the same on the fly for local testing. The
precache list is every file the browser can load (pages, scripts, styles, icons), so
a new file is picked up without anyone remembering to list it.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

PRECACHE_EXTENSIONS = {".html", ".css", ".js", ".webmanifest", ".png", ".svg"}
# Never shipped, or not part of the app: dotfiles, _site / _email-preview, tooling.
# Top level only: lib/vendor/supabase is the client library and must be cached.
SKIP_TOP_DIRS = {"supabase", "scripts", "certs", "node_modules"}
SKIP_ANY_DIRS = {"__pycache__", "node_modules"}
SKIP_FILES = {"sw.js"}  # the worker itself, and the retired per-game workers

BUILD_LINE = 'const BUILD = "dev";'
PRECACHE_LINE = "const PRECACHE = [];"


def precache_files(root: Path) -> list[Path]:
    files = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if not path.is_file() or path.suffix not in PRECACHE_EXTENSIONS:
            continue
        if path.name in SKIP_FILES:
            continue
        if relative.parts[0] in SKIP_TOP_DIRS:
            continue
        if any(part.startswith((".", "_")) or part in SKIP_ANY_DIRS for part in relative.parts):
            continue
        files.append(path)
    return files


def dev_build_id(root: Path) -> str:
    """Changes whenever a precached file does, so local edits roll out like a deploy."""
    digest = hashlib.sha1()
    for path in precache_files(root):
        stat = path.stat()
        digest.update(f"{path.relative_to(root)}:{stat.st_mtime_ns}:{stat.st_size}\n".encode())
    return f"dev-{digest.hexdigest()[:12]}"


def render_sw(root: Path, build: str) -> str:
    source = (root / "sw.js").read_text()
    if BUILD_LINE not in source or PRECACHE_LINE not in source:
        raise SystemExit("sw.js is missing the BUILD / PRECACHE lines to stamp")
    paths = [path.relative_to(root).as_posix() for path in precache_files(root)]
    return source.replace(BUILD_LINE, f"const BUILD = {json.dumps(build)};").replace(
        PRECACHE_LINE, f"const PRECACHE = {json.dumps(paths, indent=2)};"
    )


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    root = Path(sys.argv[1]).resolve()
    build = sys.argv[2].strip()
    if not build:
        raise SystemExit("empty build id")
    (root / "sw.js").write_text(render_sw(root, build))
    print(f"sw.js stamped: build {build}, {len(precache_files(root))} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
