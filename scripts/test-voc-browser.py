"""Run the OBJECT NOTE browser suite in an isolated Chromium profile."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1] / "examples" / "object-note"
MAC_CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default=shutil.which("chromium") or shutil.which("google-chrome")
                        or (str(MAC_CHROME) if MAC_CHROME.is_file() else None))
    args = parser.parse_args()
    if not args.browser:
        parser.error("a Chromium executable is needed; specify --browser")
    with tempfile.TemporaryDirectory() as profile, ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT))) as server:
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        try:
            result = subprocess.run([
                args.browser, "--headless", "--disable-gpu", "--no-first-run", "--disable-extensions",
                f"--user-data-dir={profile}", "--virtual-time-budget=15000", "--dump-dom",
                f"http://127.0.0.1:{server.server_port}/test.html",
            ], capture_output=True, text=True, timeout=45)
        finally:
            server.shutdown()
            worker.join()
    summary = re.search(r'<p id="summary"[^>]*>([^<]+)</p>', result.stdout)
    if result.returncode or not summary:
        raise SystemExit(f"VOC browser suite did not finish (code {result.returncode}):\n{result.stderr}")
    print(summary.group(1))
    if '0개 실패' not in summary.group(1):
        for failure in re.findall(r'<li class="fail">([^<]+)</li>', result.stdout):
            print(failure)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
