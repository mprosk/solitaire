#!/usr/bin/env bash
# Regenerate every PNG icon from the SVG sources.
#
#   icons/icon-source.svg          -> three cards, center sideways, outer cards
#                                    cropped at the canvas edge (purpose: any)
#   icons/icon-maskable-source.svg -> same composition scaled into the maskable
#                                    safe zone (purpose: maskable)
#
# Outputs:
#   icons/favicon-32.png         (32x32)
#   icons/apple-touch-icon.png   (180x180)
#   icons/icon-192.png           (192x192)
#   icons/icon-512.png           (512x512)
#   icons/icon-maskable-512.png  (512x512)
#
# Rendering is done with resvg (via node), NOT ImageMagick: ImageMagick's
# built-in SVG renderer cannot render <pattern> fills, which is why the
# card backs previously came out solid black.

set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' not found on PATH (needed to render SVGs with resvg)" >&2
  exit 1
fi

# Install @resvg/resvg-js once into icons/.regen-deps (kept out of git).
if ! node -e "require('@resvg/resvg-js')" 2>/dev/null &&
   ! NODE_PATH="$dir/.regen-deps/node_modules" node -e "require('@resvg/resvg-js')" 2>/dev/null; then
  echo "installing @resvg/resvg-js into icons/.regen-deps ..."
  mkdir -p "$dir/.regen-deps"
  npm install --prefix "$dir/.regen-deps" @resvg/resvg-js
fi

export NODE_PATH="$dir/.regen-deps/node_modules${NODE_PATH:+:$NODE_PATH}"
node "$dir/_regen.mjs"

echo "regenerated: favicon-32.png apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png"
