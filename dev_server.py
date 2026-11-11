"""Run with `python3 dev_server.py`; reload the browser after source changes."""

import argparse
import hashlib
import io
import json
import os
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent
WATCHED_EXTENSIONS = {'.html', '.css', '.js', '.mjs', '.json', '.svg'}
IGNORED_DIRECTORIES = {'.git', '.venv', '__pycache__', 'node_modules'}
VERSION_PATH = '/__dev_version'
MINI_PREFIX = '/mini-project/'
MINI_ROOT = ROOT.parent / 'Mini Project'
ENGINE_PREFIX = '/engine-runtime/'
ENGINE_WEB = Path(os.environ.get('CHARACTER_ENGINE_WEB', '/Users/sangmin/dev/engine/runtime/web'))


def engine_file(request_path, engine_web):
    """Expose only runtime modules, WASM, explicit character assets and their PNG art."""
    if not request_path.startswith(ENGINE_PREFIX):
        return None
    relative = unquote(request_path[len(ENGINE_PREFIX):])
    parts = Path(relative).parts
    if not parts or any(part in ('.', '..') or part.startswith('.') for part in parts):
        return None
    allowed = (
        re.fullmatch(r'[A-Za-z0-9_-]+\.js', relative)
        or relative == 'surface.wasm'
        or re.fullmatch(r'environments/lungmen/(environment\.json|[A-Za-z0-9_-]+\.png)', relative)
        or re.fullmatch(r'direction-examples/chongyue/source/skill1-effects/(effect-bundle|effect-source|effect-animation|effect-meshes|shader-programs)\.json', relative)
        or re.fullmatch(r'examples/(amiya|ayerscarpe|chongyue|shu|wang|originium-slug|basic-soldier|basic-crossbowman|crossbow-projectile)/surfaces\.json', relative)
        or re.fullmatch(r'direction-examples/(amiya|ayerscarpe|chongyue|shu|wang|originium-slug|basic-soldier|basic-crossbowman)/[^\\]+\.png', relative)
    )
    if not allowed:
        return None
    root = Path(engine_web).resolve()
    path = (root / relative).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path if path.is_file() else None


def mini_project_file(request_path, mini_root=MINI_ROOT):
    if not request_path.startswith(MINI_PREFIX):
        return None
    relative = unquote(request_path[len(MINI_PREFIX):]) or 'index.html'
    if any(part.startswith('.') for part in Path(relative).parts):
        return None
    root = Path(mini_root).resolve()
    path = (root / relative).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    if path.suffix not in {'.html', '.js', '.css', '.png'}:
        return None
    return path if path.is_file() else None


def source_version():
    """Fingerprint source contents, including added and deleted files."""
    digest = hashlib.sha256()
    for path in sorted([*ROOT.rglob('*'), *MINI_ROOT.rglob('*')]):
        relative = path.relative_to(ROOT.parent)
        if any(part in IGNORED_DIRECTORIES for part in relative.parts):
            continue
        if path.suffix not in WATCHED_EXTENSIONS or not path.is_file():
            continue
        try:
            contents = path.read_bytes()
        except FileNotFoundError:
            # An editor can replace a file while it is being scanned.
            continue
        digest.update(str(relative).encode())
        digest.update(b'\0')
        digest.update(hashlib.sha256(contents).digest())
    return digest.hexdigest()


def reload_script(version):
    return f"""
<script>
(() => {{
  const version = {json.dumps(version)};
  async function checkForChanges() {{
    try {{
      const response = await fetch('{VERSION_PATH}', {{ cache: 'no-store' }});
      if (response.ok && (await response.json()).version !== version) {{
        location.reload();
        return;
      }}
    }} catch {{
      // Retry when the development server becomes available again.
    }}
    setTimeout(checkForChanges, 700);
  }}
  setTimeout(checkForChanges, 700);
}})();
</script>
""".encode()


class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, engine_web=ENGINE_WEB, **kwargs):
        self.engine_web = engine_web
        super().__init__(*args, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return io.BytesIO(body)

    def send_head(self):
        request_path = urlsplit(self.path).path
        if request_path.startswith(ENGINE_PREFIX):
            path = engine_file(request_path, self.engine_web)
            if path is None:
                self.send_error(404, 'Engine resource not exposed')
                return None
            try:
                stream = path.open('rb')
            except OSError:
                self.send_error(404, 'Engine resource unavailable')
                return None
            self.send_response(200)
            self.send_header('Content-Type', 'application/wasm' if path.suffix == '.wasm' else self.guess_type(str(path)))
            self.send_header('Content-Length', str(path.stat().st_size))
            self.end_headers()
            return stream
        if request_path == VERSION_PATH:
            body = json.dumps({'version': source_version()}).encode()
            return self.send_bytes(body, 'application/json')

        if request_path == MINI_PREFIX.rstrip('/'):
            self.send_response(301)
            self.send_header('Location', MINI_PREFIX)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        mini = request_path.startswith(MINI_PREFIX)
        path = mini_project_file(request_path) if mini else Path(self.translate_path(self.path))
        if path is None:
            self.send_error(404, 'Mini Project resource not exposed')
            return None
        if path.is_dir():
            path = path / 'index.html'
        if path.suffix == '.html' and path.is_file():
            # Read the version first so edits during this request trigger a reload.
            version = source_version()
            try:
                body = path.read_bytes()
            except OSError:
                return super().send_head()
            script = reload_script(version)
            closing_tag = body.lower().rfind(b'</body>')
            if closing_tag >= 0:
                body = body[:closing_tag] + script + body[closing_tag:]
            else:
                body += script
            return self.send_bytes(body, 'text/html; charset=utf-8')
        if mini:
            try:
                stream = path.open('rb')
            except OSError:
                self.send_error(404)
                return None
            self.send_response(200)
            self.send_header('Content-Type', self.guess_type(str(path)))
            self.send_header('Content-Length', str(path.stat().st_size))
            self.end_headers()
            return stream
        return super().send_head()

    def log_message(self, format, *args):
        if urlsplit(self.path).path != VERSION_PATH:
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--engine-web', type=Path, default=ENGINE_WEB, help='Read-only character-engine runtime/web directory')
    args = parser.parse_args()
    handler = partial(DevHandler, directory=str(ROOT), engine_web=args.engine_web)
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        print(f'Development server: http://localhost:{args.port}', flush=True)
        print('HTML/CSS/JS changes reload the page. Stop with Ctrl+C.', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
