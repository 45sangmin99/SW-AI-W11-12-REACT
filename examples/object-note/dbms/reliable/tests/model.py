#!/usr/bin/env python3
"""Compare 600 deterministic SQL statements to a separate dictionary model.

All statements run in one real CLI session, including staged reads, rollbacks,
ID gaps, mutations and commits. A second process verifies recovered full rows.
"""
import copy
import json
import pathlib
import random
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    rng = random.Random(8675309)
    statements, expected = [], []
    current = {}
    work = current
    active = False
    next_id = 1
    for step in range(600):
        operation = rng.randrange(9)
        if operation == 0 and not active:
            statements.append("BEGIN;")
            expected.append(("plain", None))
            work = copy.deepcopy(current)
            active = True
        elif operation == 1 and active:
            if rng.randrange(2):
                statements.append("COMMIT;")
                current = work
            else:
                statements.append("ROLLBACK;")
                work = current
            expected.append(("plain", None))
            active = False
        elif operation in (0, 1, 2, 3):
            value = rng.randrange(-4, 8)
            name = f"name;{step}"
            statements.append(f"INSERT INTO records(name,k) VALUES ('{name}',{value});")
            work[next_id] = (name, value)
            expected.append(("insert", next_id))
            next_id += 1
        elif operation == 4:
            target = rng.randrange(1, next_id + 4)
            name, value = f"u{step}", rng.randrange(-4, 8)
            affected = int(target in work)
            statements.append(f"UPDATE records SET name='{name}',k={value} WHERE id={target};")
            if affected:
                work[target] = (name, value)
            expected.append(("affected", affected))
        elif operation == 5:
            target = rng.randrange(1, next_id + 4)
            affected = int(target in work)
            statements.append(f"DELETE FROM records WHERE id={target};")
            work.pop(target, None)
            expected.append(("affected", affected))
        elif operation == 6:
            target = rng.randrange(1, next_id + 4)
            statements.append(f"SELECT id,name,k FROM records WHERE id={target};")
            rows = [[str(target), work[target][0], str(work[target][1])]] if target in work else []
            expected.append(("rows", rows))
        elif operation == 7:
            value, target = rng.randrange(-4, 8), rng.randrange(1, next_id + 4)
            statements.append(f"SELECT id,name,k FROM records WHERE id={target} OR k={value} ORDER BY id;")
            rows = [[str(key), row[0], str(row[1])] for key, row in sorted(work.items())
                    if key == target or row[1] == value]
            expected.append(("rows", rows))
        else:
            statements.append("SELECT COUNT(*) FROM records;")
            expected.append(("rows", [[str(len(work))]]))
    if active:
        statements.append("COMMIT;")
        expected.append(("plain", None))
        current = work
    with tempfile.TemporaryDirectory(prefix="mdb-model-") as folder:
        directory = pathlib.Path(folder)
        (directory / "records.schema").write_text("id INT AUTO\nname VARCHAR(32)\nk INT\n")
        (directory / "records.csv").write_bytes(b"")
        sql = directory / "operations.sql"
        sql.write_text("\n".join(statements))
        command = [str(ROOT / "build/mini-db"), "--data-dir", folder]
        result = subprocess.run(command + ["--file", str(sql)], capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, (result.returncode, result.stderr, result.stdout[-2000:])
        actual = [json.loads(line) for line in result.stdout.splitlines()]
        assert len(actual) == len(expected), (len(actual), len(expected))
        for index, (body, (kind, value)) in enumerate(zip(actual, expected)):
            context = (index + 1, statements[index], body, value)
            assert body["ok"], context
            if kind == "insert":
                assert int(body["inserted_id"]) == value, context
            elif kind == "affected":
                assert int(body["affected_rows"]) == value, context
            elif kind == "rows":
                assert body["rows"] == value, context
        reopened = subprocess.run(command + ["-e", "SELECT id,name,k FROM records ORDER BY id;"],
                                  capture_output=True, text=True, timeout=120)
        assert reopened.returncode == 0, reopened.stderr
        expected_rows = [[str(key), row[0], str(row[1])] for key, row in sorted(current.items())]
        assert json.loads(reopened.stdout)["rows"] == expected_rows
        print(f"Reference-model tests passed: {len(statements)} SQL statements in one session; "
              f"{len(current)} recovered rows")


if __name__ == "__main__":
    main()
