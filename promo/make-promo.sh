#!/bin/bash
set -euo pipefail

# relay-tty promo video compositor
# Usage: ./make-promo.sh
#
# Drop your raw clips in this directory:
#   tennis-open.mp4   — kid serving/hitting (2-3s, used as hook + loop point)
#   chat.mp4          — PM chat asking for deploy (2-3s)
#   deploy.mp4        — screen recording of relay deploy on mobile (5-10s)
#   tennis-close.mp4  — kid celebrating/hitting winner (2-3s)
#
# Output: promo.mp4 (loopable ~15s GIF-style video)

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# ── Config ──────────────────────────────────────────────────────────
W=1080          # vertical/portrait for short-form
H=1920
FPS=30
FONT="/System/Library/Fonts/SFCompact.ttf"
# Fallback font if SF Compact isn't available
[ -f "$FONT" ] || FONT="/System/Library/Fonts/Helvetica.ttc"
[ -f "$FONT" ] || FONT="/System/Library/Fonts/Supplemental/Arial.ttf"
FONTSIZE=64
FONTCOLOR="white"
BORDERW=3       # text shadow/border width

# ── Preflight ───────────────────────────────────────────────────────
missing=0
for f in tennis-open.mp4 chat.mp4 deploy.mp4 tennis-close.mp4; do
  [ -f "$f" ] || { echo "missing: $f" >&2; missing=1; }
done
[ "$missing" -eq 1 ] && { echo "drop your clips in $DIR and re-run" >&2; exit 1; }

# ── Step 1: Normalize all clips to same size/fps ────────────────────
normalize() {
  local src="$1" dst="$2" dur="$3" speed="${4:-1}"
  ffmpeg -y -i "$src" \
    -vf "setpts=PTS/${speed},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS}" \
    -t "$dur" -an -c:v libx264 -preset fast -crf 23 \
    "$dst" 2>/dev/null
  echo "  ✓ $dst" >&2
}

echo "normalizing clips..." >&2
normalize tennis-open.mp4  _1_open.mp4   2.5
normalize chat.mp4         _2_chat.mp4   3
normalize deploy.mp4       _3_deploy.mp4 8  2    # 2x speed — keeps it punchy
normalize tennis-close.mp4 _4_close.mp4  2.5

# ── Step 2: Add text overlays ───────────────────────────────────────
overlay() {
  local src="$1" dst="$2" txt="$3"
  ffmpeg -y -i "$src" \
    -vf "drawtext=fontfile=${FONT}:text='${txt}':fontcolor=${FONTCOLOR}:fontsize=${FONTSIZE}:borderw=${BORDERW}:bordercolor=black:x=(w-text_w)/2:y=h-h/6" \
    -c:v libx264 -preset fast -crf 23 \
    "$dst" 2>/dev/null
  echo "  ✓ $dst ($txt)" >&2
}

echo "adding text..." >&2
overlay _1_open.mp4   _t1.mp4 "got paged at my kid's tennis match"
overlay _2_chat.mp4   _t2.mp4 "sure, one sec"
overlay _3_deploy.mp4 _t3.mp4 "deployed from the bleachers"
overlay _4_close.mp4  _t4.mp4 "didn't miss a thing"

# ── Step 3: Concatenate ─────────────────────────────────────────────
echo "joining clips..." >&2
cat > _concat.txt <<EOF
file '_t1.mp4'
file '_t2.mp4'
file '_t3.mp4'
file '_t4.mp4'
EOF

ffmpeg -y -f concat -safe 0 -i _concat.txt \
  -c:v libx264 -preset fast -crf 20 \
  -movflags +faststart \
  promo.mp4 2>/dev/null

# ── Step 4: Also make a GIF version ────────────────────────────────
echo "generating gif..." >&2
ffmpeg -y -i promo.mp4 \
  -vf "fps=15,scale=540:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" \
  promo.gif 2>/dev/null

# ── Cleanup ─────────────────────────────────────────────────────────
rm -f _1_*.mp4 _2_*.mp4 _3_*.mp4 _4_*.mp4 _t*.mp4 _concat.txt

# ── Done ────────────────────────────────────────────────────────────
ls -lh promo.mp4 promo.gif >&2
echo ""
echo "promo.mp4" # stdout = file path, POSIX style
