"""Verify VOC's route, cache, and DB-backed status changes against local servers."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / "examples" / "object-note"


def request(url, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as response:
        return response.status, response.headers, json.load(response)


def free_ports():
    with socket.socket() as db, socket.socket() as redis, socket.socket() as voc:
        for sock in (db, redis, voc):
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in (db, redis, voc)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db-bin", type=lambda p: str(Path(p).resolve()))
    parser.add_argument("--db-cli", type=lambda p: str(Path(p).resolve()))
    parser.add_argument("--redis-bin", type=lambda p: str(Path(p).resolve()))
    args = parser.parse_args()
    if bool(args.db_bin) != bool(args.db_cli):
        parser.error("--db-bin and --db-cli must be provided together")

    db_port, redis_port, voc_port = free_ports()
    base = f"http://127.0.0.1:{voc_port}"
    with tempfile.TemporaryDirectory(prefix="mini-react-voc-") as directory:
        temp = Path(directory)
        env = dict(os.environ, DB_PORT=str(db_port), REDIS_PORT=str(redis_port),
                   PROXY_PORT=str(voc_port), DATA_DIR=str(temp / "db"),
                   REDIS_AOF=str(temp / "redis.aof"), LOG_DIR=str(temp / "logs"),
                   VOC_SERVICE_LOCK=str(temp / "voc.lock"), VOC_SERVICE_URL=base)
        for key in ("NO_REDIS", "SIMULATE", "MINIDB_TOKEN", "DB_BIN", "DB_CLI", "REDIS_BIN"):
            env.pop(key, None)
        for key in ("db_bin", "db_cli", "redis_bin"):
            if getattr(args, key):
                env[key.upper()] = getattr(args, key)
        with (temp / "startup.log").open("w+") as log:
            proc = subprocess.Popen(["bash", "tools/start-all.sh"], cwd=ROOT, env=env,
                                    stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        raise RuntimeError("VOC startup exited")
                    try:
                        if request(base + "/api/v1/overview")[0] == 200:
                            break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise TimeoutError("VOC startup timed out")
                with urllib.request.urlopen(base + "/voc.html", timeout=5) as page:
                    assert "OBJECT NOTE" in page.read().decode()

                path = base + "/api/v1/overview?category=" + urllib.parse.quote("배송")
                _, cold_headers, cold = request(path)
                _, hot_headers, hot = request(path)
                assert cold_headers["X-Data-Source"] == "dbms"
                assert hot_headers["X-Data-Source"] == "redis"
                assert cold.pop("dataSource") == "dbms" and hot.pop("dataSource") == "redis"
                assert cold == hot

                _, _, alerts = request(base + "/api/v1/alerts")
                alert_id = urllib.parse.quote(alerts["alerts"][0]["id"], safe="")
                alert = base + f"/api/v1/alerts/{alert_id}"
                _, _, before = request(alert + "/status-history")
                assert before["history"] == []
                _, headers, _ = request(alert + "/status-history")
                assert headers["X-Data-Source"] == "redis"
                status, _, saved = request(alert + "/status", {"status": "해결"})
                assert status == 201 and saved["status"] == "해결"
                _, headers, after = request(alert + "/status-history")
                assert headers["X-Data-Source"] == "dbms"
                assert after["currentStatus"] == "해결" and len(after["history"]) == 1
                print("VOC HTTP: DBMS → Redis HIT, status save, cache invalidation passed")
            except Exception:
                log.seek(0)
                print(log.read())
                for error_log in sorted((temp / "logs").glob("*.log")):
                    print(error_log.name, error_log.read_text(errors="replace")[-3000:])
                raise
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()


if __name__ == "__main__":
    main()
