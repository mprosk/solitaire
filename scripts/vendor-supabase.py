#!/usr/bin/env python3
"""Vendor supabase-js from jsDelivr's +esm builds into lib/vendor/supabase.

Usage: python3 scripts/vendor-supabase.py 2.117.2
Then update the import in lib/supabase.js to the new version.
"""

from __future__ import annotations

import re
import sys
import urllib.request
from pathlib import Path

CDN = "https://cdn.jsdelivr.net"
OUT = Path(__file__).resolve().parent.parent / "lib" / "vendor" / "supabase"
IMPORT_RE = re.compile(r'(?:from|import)\s*\(?\s*"(/npm/[^"]+/\+esm)"')


def local_name(path: str) -> str:
    match = re.match(r"/npm/(?:@[^/]+/)?([^@/]+)@([^/]+)/\+esm$", path)
    if not match:
        raise ValueError(f"unexpected import path: {path}")
    return f"{match.group(1)}-{match.group(2)}.js"


def fetch(path: str) -> str:
    with urllib.request.urlopen(CDN + path, timeout=60) as response:
        return response.read().decode("utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 1
    todo = [f"/npm/@supabase/supabase-js@{sys.argv[1]}/+esm"]
    files: dict[str, str] = {}
    while todo:
        path = todo.pop()
        if path in files:
            continue
        source = fetch(path)
        deps = set(IMPORT_RE.findall(source))
        for dep in deps:
            source = source.replace(f'"{dep}"', f'"./{local_name(dep)}"')
        files[path] = source
        todo.extend(dep for dep in deps if dep not in files)

    for old in OUT.glob("*.js"):
        old.unlink()
    for path, source in files.items():
        (OUT / local_name(path)).write_text(source)
        print(local_name(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
