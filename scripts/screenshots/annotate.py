"""Draw numbered annotation callouts in side margins, with leader lines pointing at features."""

import argparse
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


# Annotation style constants (all in retina pixels at given scale)
CIRCLE_RADIUS = 42  # 14px at 1x scale=3
CIRCLE_COLOR = (103, 58, 183)  # Deep purple #673AB7
CIRCLE_OUTLINE = (255, 255, 255)
LABEL_BG = (30, 28, 50, 230)  # Slightly lighter than margin, visible
LABEL_TEXT_COLOR = (230, 230, 240)
LEADER_COLOR = (140, 100, 220, 200)  # Lighter purple for visibility against margin
LEADER_WIDTH = 4
LEADER_DOT_RADIUS = 12  # Dot at target end
LEADER_DOT_COLOR = (255, 200, 60, 230)  # Amber dot at target — stands out against dark UI
FONT_SIZE_NUMBER = 36
FONT_SIZE_LABEL = 28
LABEL_PADDING_X = 15
LABEL_PADDING_Y = 8
MARGIN_WIDTH = 280  # Width of each margin (left + right)
MARGIN_BG = (22, 20, 35)  # Distinct from screenshot — slightly purple-tinted dark


def get_font(size):
    """Try to load a good monospace font, fall back to default."""
    candidates = [
        "/System/Library/Fonts/SFMono-Regular.otf",
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def draw_circle(draw, cx, cy, label, font_number):
    """Draw a filled numbered circle."""
    r = CIRCLE_RADIUS
    draw.ellipse(
        [cx - r - 3, cy - r - 3, cx + r + 3, cy + r + 3],
        fill=CIRCLE_OUTLINE,
    )
    draw.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        fill=CIRCLE_COLOR,
    )
    bbox = draw.textbbox((0, 0), label, font=font_number)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    draw.text(
        (cx - tw / 2, cy - th / 2 - 2),
        label,
        fill=(255, 255, 255),
        font=font_number,
    )


def annotate(manifest_path: Path, raw_dir: Path, output_dir: Path):
    manifest = json.loads(manifest_path.read_text())
    output_dir.mkdir(parents=True, exist_ok=True)

    font_number = get_font(FONT_SIZE_NUMBER)
    font_label = get_font(FONT_SIZE_LABEL)

    for screen in manifest:
        sid = screen["id"]
        raw_path = raw_dir / f"{sid}.png"

        if not raw_path.exists():
            print(f"  [{sid}] raw PNG not found, skipping", file=sys.stderr)
            continue

        raw_img = Image.open(raw_path).convert("RGBA")
        scale = screen.get("scale", 3)
        annotations = screen.get("annotations", [])

        if not annotations:
            out_path = output_dir / f"{sid}.png"
            raw_img.convert("RGB").save(out_path, "PNG", optimize=True)
            print(f"  [{sid}] (no annotations) -> {out_path}", file=sys.stderr)
            continue

        margin_px = MARGIN_WIDTH * scale // 3

        # Canvas: left margin + screenshot + right margin
        canvas_w = margin_px + raw_img.width + margin_px
        canvas = Image.new("RGBA", (canvas_w, raw_img.height), (*MARGIN_BG, 255))

        # Paste screenshot in center
        img_offset_x = margin_px
        canvas.paste(raw_img, (img_offset_x, 0))

        # Draw subtle border between margins and screenshot
        draw_canvas = ImageDraw.Draw(canvas)
        border_color = (60, 55, 80)
        draw_canvas.line([(margin_px, 0), (margin_px, raw_img.height)], fill=border_color, width=2)
        draw_canvas.line([(margin_px + raw_img.width, 0), (margin_px + raw_img.width, raw_img.height)], fill=border_color, width=2)

        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        draw_overlay = ImageDraw.Draw(overlay)

        # Assign each annotation to left or right margin based on which side
        # of the screenshot the target is on (closer to left edge → left margin, etc.)
        img_center_x = raw_img.width / 2
        left_anns = []
        right_anns = []
        for ann in annotations:
            tx_in_img = ann["x"] * scale
            if tx_in_img < img_center_x:
                left_anns.append(ann)
            else:
                right_anns.append(ann)

        # If all ended up on one side, split evenly by order
        if not left_anns and right_anns:
            mid = len(right_anns) // 2
            left_anns = right_anns[:mid]
            right_anns = right_anns[mid:]
        elif not right_anns and left_anns:
            mid = len(left_anns) // 2
            right_anns = left_anns[mid:]
            left_anns = left_anns[:mid]

        def draw_annotations(anns, side):
            n = len(anns)
            if n == 0:
                return

            if side == "left":
                margin_center_x = margin_px // 2
            else:
                margin_center_x = margin_px + raw_img.width + margin_px // 2

            padding_top = raw_img.height * 0.06
            padding_bot = raw_img.height * 0.06
            usable_h = raw_img.height - padding_top - padding_bot

            for i, ann in enumerate(anns):
                # Target point (on the screenshot, offset by left margin)
                tx = int(ann["x"] * scale) + img_offset_x
                ty = int(ann["y"] * scale)

                # Circle Y: evenly spaced in this margin
                if n == 1:
                    cy = int(raw_img.height / 2)
                else:
                    cy = int(padding_top + (usable_h * i / (n - 1)))
                cx = margin_center_x

                label = ann["label"]
                text = ann.get("text", "")

                # Amber dot at target
                draw_overlay.ellipse(
                    [tx - LEADER_DOT_RADIUS, ty - LEADER_DOT_RADIUS,
                     tx + LEADER_DOT_RADIUS, ty + LEADER_DOT_RADIUS],
                    fill=LEADER_DOT_COLOR,
                )

                # Leader line
                r = CIRCLE_RADIUS
                if side == "left":
                    line_start_x = cx + r + 3
                else:
                    line_start_x = cx - r - 3
                draw_overlay.line(
                    [(line_start_x, cy), (tx, ty)],
                    fill=LEADER_COLOR,
                    width=LEADER_WIDTH,
                )

                # Circle
                draw_circle(draw_canvas, cx, cy, label, font_number)

                # Label below circle
                if text:
                    bbox = draw_canvas.textbbox((0, 0), text, font=font_label)
                    tw = bbox[2] - bbox[0]
                    th = bbox[3] - bbox[1]
                    label_x = cx - tw / 2
                    label_y = cy + CIRCLE_RADIUS + 10

                    draw_overlay.rounded_rectangle(
                        (label_x - LABEL_PADDING_X, label_y - LABEL_PADDING_Y,
                         label_x + tw + LABEL_PADDING_X, label_y + th + LABEL_PADDING_Y),
                        radius=9,
                        fill=LABEL_BG,
                    )
                    draw_overlay.text(
                        (label_x, label_y),
                        text,
                        fill=LABEL_TEXT_COLOR,
                        font=font_label,
                    )

        draw_annotations(left_anns, "left")
        draw_annotations(right_anns, "right")

        canvas = Image.alpha_composite(canvas, overlay)

        out_path = output_dir / f"{sid}.png"
        canvas.convert("RGB").save(out_path, "PNG", optimize=True)
        print(f"  [{sid}] annotated -> {out_path}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="Annotate relay-tty screenshots")
    parser.add_argument("--raw", default="_raw", help="Directory with raw PNGs")
    parser.add_argument("--manifest", default="manifest.json", help="Path to manifest.json")
    parser.add_argument("--output", default="../../website/assets/images/mobile", help="Output directory")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        manifest_path = Path(__file__).parent / args.manifest

    print("Annotating screenshots...", file=sys.stderr)
    annotate(manifest_path, Path(args.raw), Path(args.output))
    print("Done.", file=sys.stderr)


if __name__ == "__main__":
    main()
