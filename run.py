"""SEEG Demo 启动入口"""
import sys
import os
import webbrowser
import threading
import argparse

import uvicorn


def get_base_path():
    if hasattr(sys, '_MEIPASS'):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


def open_browser(host, port):
    import time
    time.sleep(1.5)
    browser_host = "localhost" if host in ("0.0.0.0", "::") else host
    webbrowser.open(f"http://{browser_host}:{port}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SEEG Demo v3")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    os.chdir(get_base_path())
    if not args.no_browser:
        threading.Thread(target=open_browser, args=(args.host, args.port), daemon=True).start()
    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        log_level="info",
    )
