#!/usr/bin/env python3
"""Minimal local static host for the solitaire monorepo."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from flask import Flask, send_from_directory

ROOT = Path(__file__).resolve().parent
app = Flask(__name__)

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/javascript", ".js")


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def host(path: str):
    if not path or path.endswith("/") or (ROOT / path).is_dir():
        path = f"{path.rstrip('/')}/index.html" if path else "index.html"
    return send_from_directory(ROOT, path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8888, debug=True)
