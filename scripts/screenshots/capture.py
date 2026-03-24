"""Capture mobile-viewport screenshots of relay-tty web UI using Playwright."""

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def run_setup(page, actions):
    """Execute setup actions on the page."""
    for action in actions:
        cmd = action[0]
        if cmd == "click":
            page.click(action[1], timeout=5000)
        elif cmd == "click_text":
            page.get_by_text(action[1]).first.click(timeout=5000)
        elif cmd == "wait":
            page.wait_for_selector(action[1], timeout=5000)
        elif cmd == "sleep":
            page.wait_for_timeout(action[1])
        elif cmd == "type":
            page.fill(action[1], action[2])
        elif cmd == "eval":
            page.evaluate(action[1])
        else:
            print(f"  Unknown action: {cmd}", file=sys.stderr)


def capture(manifest_path: Path, session_id: str, output_dir: Path, base_url: str):
    manifest = json.loads(manifest_path.read_text())
    output_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        for screen in manifest:
            sid = screen["id"]
            vp = screen.get("viewport", {"width": 390, "height": 844})

            scale = screen.get("scale", 3)
            is_mobile = vp["width"] < 768
            user_agent = (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
                if is_mobile
                else "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )

            context = browser.new_context(
                viewport={"width": vp["width"], "height": vp["height"]},
                device_scale_factor=scale,
                is_mobile=is_mobile,
                has_touch=is_mobile,
                user_agent=user_agent,
            )
            page = context.new_page()

            url = screen["url"].replace("{session_id}", session_id)
            full_url = f"{base_url}{url}"
            print(f"  [{sid}] {full_url}", file=sys.stderr)

            try:
                page.goto(full_url, wait_until="networkidle", timeout=15000)
            except Exception:
                # networkidle can be flaky with WS connections, fall back
                page.goto(full_url, wait_until="domcontentloaded", timeout=15000)

            # Wait for key element
            wait_for = screen.get("waitFor")
            if wait_for:
                try:
                    page.wait_for_selector(wait_for, timeout=10000)
                except Exception:
                    print(f"  [{sid}] Warning: waitFor '{wait_for}' not found, continuing", file=sys.stderr)

            # Extra delay for async rendering (xterm, WS replay)
            delay = screen.get("delay", 1500)
            page.wait_for_timeout(delay)

            # Run setup actions
            setup = screen.get("setup", [])
            if setup:
                try:
                    run_setup(page, setup)
                    page.wait_for_timeout(500)
                except Exception as e:
                    print(f"  [{sid}] Warning: setup failed: {e}", file=sys.stderr)

            # Capture
            out_path = output_dir / f"{sid}.png"
            page.screenshot(path=str(out_path), full_page=False)
            print(f"  [{sid}] saved {out_path}", file=sys.stderr)

            context.close()

        browser.close()


def main():
    parser = argparse.ArgumentParser(description="Capture relay-tty screenshots")
    parser.add_argument("--session-id", required=True, help="Session ID to use in URLs")
    parser.add_argument("--output", default="_raw", help="Output directory for raw PNGs")
    parser.add_argument("--manifest", default="manifest.json", help="Path to manifest.json")
    parser.add_argument("--base-url", default="http://localhost:7680", help="Base URL of relay-tty server")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        # Try relative to script directory
        manifest_path = Path(__file__).parent / args.manifest

    print("Capturing screenshots...", file=sys.stderr)
    capture(manifest_path, args.session_id, Path(args.output), args.base_url)
    print("Done.", file=sys.stderr)


if __name__ == "__main__":
    main()
