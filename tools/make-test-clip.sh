#!/usr/bin/env bash
# Regenerate the segmentation test clip: 16 s, tone / silence in known places, so a
# pause point can be checked against a number instead of a feeling.
#
#   tone   0–2   silence 2–4
#   tone   4–6   silence 6–8
#   tone   8–10  silence 10–16
#
# With the default preset (−45 dB, 0.6 s) the player must pause at ≈2.6 / ≈6.6 / ≈10.6.
# Serve it from a Range-capable server (this project's own server is fine) — without
# Range, video.seekable.end is 0 and every seek silently clamps to 0.
set -euo pipefail
OUT="${1:-web/mock/segtest.mp4}"
mkdir -p "$(dirname "$OUT")"
ffmpeg -y -loglevel error \
  -f lavfi -i "testsrc2=size=640x360:rate=30:duration=16" \
  -f lavfi -i "sine=frequency=440:duration=16" \
  -filter_complex "[1:a]volume=enable='between(t,2,4)':volume=0,volume=enable='between(t,6,8)':volume=0,volume=enable='between(t,10,16)':volume=0[a]" \
  -map 0:v -map "[a]" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -movflags +faststart "$OUT"
echo "wrote $OUT"
