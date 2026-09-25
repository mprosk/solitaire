#!/usr/bin/env python3
"""Local static server for PWA testing (optional HTTPS)."""

from __future__ import annotations

import argparse
import http.server
import mimetypes
import socket
import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CERT = ROOT / "certs" / "cert.pem"
KEY = ROOT / "certs" / "key.pem"

# Ensure correct types even when the OS mime database is incomplete.
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("application/javascript", ".js")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Dev ergonomics: never let the browser HTTP-cache game assets, so a
        # plain reload always picks up fresh CSS/JS (the service worker cache
        # is a separate layer — see ?sw=off in index.html).
        if self.path.split("?")[0].lower().endswith(
            (".html", ".css", ".js", ".webmanifest")
        ):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        # Prefer our forced mappings over whatever guess_type returns.
        lower = path.lower()
        if lower.endswith(".webmanifest"):
            return "application/manifest+json"
        if lower.endswith(".js"):
            return "application/javascript"
        return super().guess_type(path)


def lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve The Hated Game for local / phone PWA testing.")
    parser.add_argument("port", nargs="?", type=int, default=8080, help="Port (default: 8080)")
    parser.add_argument(
        "--https",
        action="store_true",
        help=f"Serve HTTPS using {CERT.relative_to(ROOT)} and {KEY.relative_to(ROOT)}",
    )
    args = parser.parse_args()

    scheme = "http"
    server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)

    if args.https:
        if not CERT.is_file() or not KEY.is_file():
            print(
                "HTTPS requested but certs are missing.\n"
                f"  Expected: {CERT}\n"
                f"            {KEY}\n"
                "Generate a self-signed cert, then re-run with --https:\n"
                "  mkdir -p certs\n"
                '  openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem '
                '-out certs/cert.pem -days 365 -subj "/CN=localhost"',
                file=sys.stderr,
            )
            return 1
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=str(CERT), keyfile=str(KEY))
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        scheme = "https"

    host = lan_ip()
    print(f"Serving {ROOT}")
    print(f"  Local:  {scheme}://127.0.0.1:{args.port}/")
    print(f"  LAN:    {scheme}://{host}:{args.port}/")
    print()
    if scheme == "http":
        print(
            "Note: Phone standalone install (no address bar) needs a secure context (HTTPS).\n"
            "  HTTP over LAN only creates a home-screen shortcut, not a real PWA install.\n"
            "  Options: run with --https (self-signed certs in certs/), or use a tunnel\n"
            "  (localtunnel / cloudflared) and Add to Home Screen from the https URL."
        )
    else:
        print(
            "Serving HTTPS. Accept the certificate warning on your phone if using a self-signed cert.\n"
            "  Then Add to Home Screen / Install from this https URL for standalone mode."
        )
    print("Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
