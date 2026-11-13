#!/usr/bin/env python3
"""Reproducible real-HTTP benchmark; never retries an ambiguous SQL request.

By default a temporary database is populated through one CLI transaction.  An
explicit --data-dir reuses prepared benchmark data and mixed runs UPDATE names.
Each HTTP request uses a new connection, matching the server's close policy.
"""
import argparse
import concurrent.futures
import contextlib
import json
import math
import os
import pathlib
import platform
import random
import secrets
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]


def integer_list(value):
    try:
        result = [int(item) for item in value.split(",")]
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected comma-separated integers") from error
    if not result or any(item < 1 or item > 128 for item in result):
        raise argparse.ArgumentTypeError("values must be in 1..128")
    return result


class Client:
    def __init__(self, url, token, timeout):
        self.url = url
        self.token = token
        self.timeout = timeout
        self.local = threading.local()

    def request(self, sql=None, health=False):
        if not hasattr(self.local, "opener"):
            self.local.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        headers = {"Authorization": "Bearer " + self.token}
        data = None
        if sql is not None:
            data = json.dumps({"sql": sql}, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.url + ("/health" if health else "/query"),
            data=data,
            headers=headers,
            method="GET" if health else "POST",
        )
        try:
            with self.local.opener.open(request, timeout=self.timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            payload = error.read()
            try:
                body = json.loads(payload)
            except (ValueError, UnicodeError):
                body = {"ok": False, "error": {"code": "NON_JSON_ERROR"}}
            return error.code, body


def checked(client, sql):
    status, body = client.request(sql)
    if status != 200 or not body.get("ok"):
        raise RuntimeError("setup/validation query failed: " + json.dumps(body))
    return body


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def prepare_database(directory, count, sql_file, timeout):
    directory.mkdir(parents=True)
    start = time.perf_counter()
    (directory / "records.schema").write_text(
        "id INT AUTO\nname VARCHAR(32)\nk INT\n", encoding="ascii"
    )
    (directory / "records.csv").write_bytes(b"")
    with sql_file.open("w", encoding="ascii") as output:
        output.write("BEGIN;\n")
        for key in range(1, count + 1):
            output.write(f"INSERT INTO records (name,k) VALUES ('bench',{key});\n")
        output.write("COMMIT;\n")
    generated = time.perf_counter() - start
    environment = os.environ.copy()
    environment.pop("MDB_FAILPOINT", None)
    environment.pop("MDB_FORCE_SCAN", None)
    start = time.perf_counter()
    result = subprocess.run(
        [str(ROOT / "build/mini-db"), "--data-dir", str(directory), "--file", str(sql_file)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        env=environment,
        check=False,
    )
    elapsed = time.perf_counter() - start
    if result.returncode:
        raise RuntimeError("CLI preparation failed: " + result.stderr[-4000:])
    sql_file.unlink()
    return {
        "method": "SQL file -> CLI parser/validator/INSERT executor -> one explicit COMMIT",
        "sql_file_generation_s": generated,
        "cli_sql_insert_commit_s": elapsed,
        "transaction_size": count,
        "stdout": "redirected to /dev/null; CLI result formatting cost remains included",
    }


@contextlib.contextmanager
def running_server(directory, workers, args, log_directory):
    port = unused_port()
    token = secrets.token_hex(24)
    environment = os.environ.copy()
    environment["MINIDB_TOKEN"] = token
    # Reproducible benchmarks must not inherit a caller's crash-injection hook.
    environment.pop("MDB_FAILPOINT", None)
    environment.pop("MDB_FORCE_SCAN", None)
    log_path = log_directory / f"server-workers-{workers}.log"
    with log_path.open("wb") as log:
        start = time.perf_counter()
        command = [
            str(ROOT / "build/mini-db-server"), "--data-dir", str(directory),
            "--bind", "127.0.0.1", "--port", str(port), "--threads", str(workers),
            "--queue", "512", "--max-conn", "512", "--read-timeout", "60",
        ]
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=log, env=environment)
        client = Client(f"http://127.0.0.1:{port}", token, args.timeout)
        try:
            deadline = time.monotonic() + args.startup_timeout
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("server exited during startup: " + log_path.read_text(errors="replace")[-4000:])
                try:
                    status, body = client.request(health=True)
                    if status == 200 and body.get("ok"):
                        break
                except (OSError, urllib.error.URLError, TimeoutError, ValueError):
                    pass
                time.sleep(0.05)
            else:
                raise RuntimeError("server startup/recovery exceeded timeout")
            startup = time.perf_counter() - start
            yield client, startup
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try:
                    process.wait(timeout=args.shutdown_timeout)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise RuntimeError("server graceful shutdown exceeded timeout")
            if process.returncode:
                raise RuntimeError("server terminated abnormally: " + log_path.read_text(errors="replace")[-4000:])


def query_for(workload, index, key, write_every):
    if workload == "mixed" and index % write_every == 0:
        return f"UPDATE records SET name='mixed' WHERE id={key};", "update"
    field = "k" if workload == "scan" else "id"
    return f"SELECT id,k FROM records WHERE {field}={key};", field


def run_batch(client, workers, clients, workload, args, repeat):
    rng = random.Random(args.seed + repeat)
    # ID 2 is excluded so --data-dir can reuse bench.py's post-DELETE dataset.
    keys = [rng.randint(3, args.count) for _ in range(args.requests)]
    barrier = threading.Barrier(min(clients, args.requests))

    def run_one(index):
        sql, operation = query_for(workload, index, keys[index], args.write_every)
        if index < min(clients, args.requests):
            barrier.wait(timeout=30)
        begin = time.perf_counter()
        result = {"operation": operation}
        try:
            status, body = client.request(sql)
            result.update(status=status, code=(body.get("error") or {}).get("code"))
            if status == 200 and body.get("ok"):
                if operation == "update":
                    valid = body.get("commit") == "DURABLE" and int(body.get("affected_rows", -1)) == 1
                else:
                    rows = body.get("rows", [])
                    valid = (len(rows) == 1 and len(rows[0]) == 2 and
                             int(rows[0][0]) == keys[index] and int(rows[0][1]) == keys[index] and
                             bool(body.get("used_index")) == (operation == "id"))
                result["outcome"] = "success" if valid else "incorrect_result"
            elif status == 409 and result["code"] == "ERR_CONFLICT":
                result["outcome"] = "conflict"
            elif status == 503:
                result["outcome"] = "busy"
            else:
                result["outcome"] = "http_error"
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            result.update(outcome="transport_unknown", detail=str(error)[:200])
        except (ValueError, KeyError, TypeError) as error:
            result.update(outcome="incorrect_result", detail=str(error)[:200])
        result["latency_s"] = time.perf_counter() - begin
        return result

    begin = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=clients) as executor:
        responses = list(executor.map(run_one, range(args.requests)))
    wall = time.perf_counter() - begin
    latencies = sorted(response["latency_s"] for response in responses)
    outcomes = {}
    errors = {}
    operations = {}
    for response in responses:
        key = response["outcome"]
        outcomes[key] = outcomes.get(key, 0) + 1
        operations[response["operation"]] = operations.get(response["operation"], 0) + 1
        if response.get("code"):
            errors[response["code"]] = errors.get(response["code"], 0) + 1
    return {
        "workers": workers, "clients": clients, "workload": workload,
        "repeat": repeat, "requests": args.requests, "operations": operations,
        "elapsed_s": wall, "requests_per_second": args.requests / wall,
        "successful_requests_per_second": outcomes.get("success", 0) / wall,
        "latency_mean_s": statistics.mean(latencies),
        "latency_median_s": statistics.median(latencies),
        "latency_p99_s": latencies[math.ceil(len(latencies) * 0.99) - 1],
        "latency_max_s": latencies[-1], "outcomes": outcomes, "error_codes": errors,
        "unexpected_samples": [r for r in responses if r["outcome"] not in ("success", "conflict", "busy")][:5],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=1_000_000)
    parser.add_argument("--requests", type=int, default=128, help="measured requests per batch")
    parser.add_argument("--workers", type=integer_list, default=[1, 2, 4, 8])
    parser.add_argument("--clients", type=integer_list, default=[1, 4, 16, 64])
    parser.add_argument("--workloads", default="index,scan,mixed")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--warmups", type=int, default=4)
    parser.add_argument("--write-every", type=int, default=16)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--startup-timeout", type=float, default=300)
    parser.add_argument("--shutdown-timeout", type=float, default=180)
    parser.add_argument("--prepare-timeout", type=float, default=900)
    parser.add_argument("--data-dir", type=pathlib.Path,
                        help="reuse a prepared records benchmark DB; mixed workload UPDATEs names")
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "bench-server-results.json")
    args = parser.parse_args()
    workloads = args.workloads.split(",")
    if (args.count < 3 or args.count > 10_000_000 or args.requests < 1 or
            args.repeats < 1 or args.warmups < 0 or args.write_every < 1 or
            any(name not in ("index", "scan", "mixed") for name in workloads) or
            any(value <= 0 for value in (args.timeout, args.startup_timeout, args.shutdown_timeout, args.prepare_timeout))):
        parser.error("invalid count, request count, workload, or timing option")
    subprocess.run(["make", "all"], cwd=ROOT, check=True)
    result = {
        "count_requested": args.count, "seed": args.seed,
        "platform": platform.platform(), "python": platform.python_version(),
        "measurement": "wall-clock real loopback HTTP; includes connection, JSON encode/decode and body read; excludes terminal output",
        "cache": "warm engine and OS cache after startup plus explicit warmups; no cold-cache claim",
        "durability": "normal WAL/CSV fsync policy; no relaxed durability mode",
        "isolation": "global optimistic commit version; mixed writes may conflict even for different rows",
        "mixed_write_fraction": f"1/{args.write_every}; UPDATE keeps id and k stable",
        "percentile": "nearest-rank p99 across successful and failed measured requests; report sample size",
        "retry_policy": "none; transport failure may have committed and is recorded as unknown",
        "rows_are_strings": "INT results are decimal strings to preserve int64 precision",
        "batches": [], "server_startups": [], "unix_time": time.time(),
    }
    with tempfile.TemporaryDirectory(prefix="mdb-server-bench-") as folder:
        working = pathlib.Path(folder)
        if args.data_dir is None:
            directory = working / "data"
            result["preparation"] = prepare_database(directory, args.count, working / "load.sql", args.prepare_timeout)
        else:
            directory = args.data_dir.resolve()
            if not (directory / "records.schema").is_file() or not (directory / ".mdb.init").is_file():
                parser.error("--data-dir must contain an already prepared records benchmark database")
            result["preparation"] = {"method": "reused prepared benchmark DB", "data_dir": str(directory)}
        for workers in args.workers:
            with running_server(directory, workers, args, working) as (client, startup):
                result["server_startups"].append({"workers": workers, "recovery_open_listen_s": startup})
                total = checked(client, "SELECT COUNT(*) FROM records;")
                actual_count = int(total["rows"][0][0])
                if actual_count not in (args.count, args.count - 1):
                    raise RuntimeError(f"benchmark dataset count mismatch: {actual_count} vs {args.count}")
                result["actual_rows"] = actual_count
                # Validate the id/k correspondence before using it as an oracle.
                for key in (3, args.count):
                    body = checked(client, f"SELECT id,k FROM records WHERE id={key};")
                    if len(body["rows"]) != 1 or [int(x) for x in body["rows"][0]] != [key, key]:
                        raise RuntimeError("prepared data must contain id=k=3..count")
                for clients in args.clients:
                    for workload in workloads:
                        for _ in range(args.warmups):
                            checked(client, "SELECT id,k FROM records WHERE " + ("k" if workload == "scan" else "id") + "=3;")
                        for repeat in range(args.repeats):
                            batch = run_batch(client, workers, clients, workload, args, repeat)
                            result["batches"].append(batch)
                            args.output.parent.mkdir(parents=True, exist_ok=True)
                            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                            print(json.dumps(batch, ensure_ascii=False), flush=True)
                after = checked(client, "SELECT COUNT(*) FROM records;")
                if int(after["rows"][0][0]) != actual_count:
                    raise RuntimeError("mixed benchmark changed the number of rows")
        result["completed"] = True
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Results: " + str(args.output), file=sys.stderr)
    unexpected = sum(sum(batch["outcomes"].get(key, 0) for key in ("incorrect_result", "http_error", "transport_unknown")) for batch in result["batches"])
    return 1 if unexpected else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, subprocess.SubprocessError, OSError) as error:
        print("Benchmark failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
