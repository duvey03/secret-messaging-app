#!/usr/bin/env python3
"""
Local dev server for the Secret Messaging App.
Run: python3 run.py [port]
Default port: 8080.
"""

import http.server
import os
import socketserver
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_PORT = 8080


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Disable caching so JS/CSS edits show up on refresh.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Suppress 200/304 chatter; keep errors.
        try:
            status = int(args[1])
            if 200 <= status < 400:
                return
        except (IndexError, ValueError):
            pass
        super().log_message(fmt, *args)


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"[ERROR] Invalid port: {sys.argv[1]}")
            sys.exit(1)

    os.chdir(ROOT)
    url = f"http://localhost:{port}"

    print("=" * 60)
    print(f"[SUCCESS] Serving at {url}")
    print("=" * 60)
    print("Quick test:")
    print("  1. Type anything in the composer -> scripted cover response")
    print("  2. Konami code: Up Up Down Down Left Right Left Right B A")
    print("  3. Set any PIN -> unlocks (still showing cover view)")
    print("  4. Park cursor in the invisible hotspot just left of composer")
    print("     -> real mode visible. Send a message; mock reply in 1-5s.")
    print("  5. Move cursor away -> cover returns")
    print("  6. Triple-Esc or Alt-Tab -> full panic lock")
    print("=" * 60)
    print("Debug from devtools console:")
    print("  __sma.state(), __sma.panic(), __sma.setUseMock(false)")
    print("=" * 60)
    print("Ctrl+C to stop")
    sys.stdout.flush()

    # Browser open is best-effort and runs in a daemon thread so it can't
    # block server startup (webbrowser.open shells out to wslview/xdg-open
    # which can hang in headless WSL).
    if os.environ.get("NO_BROWSER") != "1":
        def _open_browser():
            time.sleep(0.5)
            try:
                webbrowser.open(url)
            except Exception:
                pass
        threading.Thread(target=_open_browser, daemon=True).start()

    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("", port), QuietHandler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[INFO] Server stopped")
    except OSError as e:
        if e.errno in (98, 10048):  # EADDRINUSE
            print(f"[ERROR] Port {port} already in use. Try: python3 run.py 8081")
            sys.exit(1)
        raise


if __name__ == "__main__":
    main()
