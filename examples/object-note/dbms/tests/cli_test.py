"""CLI/engine acceptance tests using real files, processes and JSON results."""
import ctypes
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

BINARY = pathlib.Path(sys.argv.pop(1)).resolve()


class CLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mini-db-cli-")
        self.cwd = pathlib.Path(self.temp.name)
        self.db = self.cwd / "database with spaces"
        self.db.mkdir()
        (self.db / "schema.txt").write_text(
            "users id:INTEGER name:TEXT(64) age:INTEGER\n"
            "products id:INTEGER name:TEXT(16) price:INTEGER\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def command(self, *args, ok=True):
        result = subprocess.run([str(BINARY), *map(str, args)], cwd=self.cwd,
                                capture_output=True, text=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def ready(self):
        self.command("prepare", "--data-dir", self.db)
        self.command("init", "--data-dir", self.db)

    def sql(self, source, ok=True):
        path = self.cwd / "queries.sql"
        path.write_text(source, encoding="utf-8")
        result = self.command("run", path, ok=ok)
        return json.loads(result.stdout) if ok else result

    def test_cli_persists_ids_projects_filters_and_separates_tables(self):
        self.ready()
        output = self.sql("INSERT INTO users (age,name) VALUES (25,'김,민수; O''Brien');"
                          "INSERT INTO users (name,age) VALUES ('지수',28);"
                          "INSERT INTO products (name,price) VALUES ('책',3000);"
                          "SELECT name,id FROM users WHERE age=25;")
        self.assertEqual(output[0]["id"], 1)
        self.assertEqual(output[1]["id"], 2)
        self.assertEqual(output[2]["id"], 1)
        self.assertEqual(output[3]["columns"], ["name", "id"])
        self.assertEqual(output[3]["rows"], [["김,민수; O'Brien", 1]])
        self.assertEqual(self.sql("select * from USERS where id=2")[0]["rows"], [[2, "지수", 28]])
        self.assertEqual(self.sql("SELECT * FROM users WHERE name='없음';")[0]["rows"], [])
        self.assertEqual(self.sql("INSERT INTO users (name,age) VALUES ('영희',30);")[0]["id"], 3)
        self.command("prepare", "--data-dir", self.db)  # Never truncates existing data.
        self.assertEqual(self.sql("SELECT * FROM users;")[0]["count"], 3)

    def test_invalid_queries_do_not_append_or_consume_ids(self):
        self.ready()
        invalid = [
            "INSERT INTO missing (name,age) VALUES ('a',1);",
            "INSERT INTO users (name,age) VALUES ('a','wrong');",
            "INSERT INTO users (name,age) VALUES ('" + "x" * 65 + "',1);",
            "INSERT INTO users (name,unknown) VALUES ('a',1);",
            "INSERT INTO users (id,name,age) VALUES (1,'a',1);",
            "INSERT INTO users (name) VALUES ('a');",
            "INSERT INTO users (name,age) VALUES ('bad,1);",
            "INSERT INTO users (name,age) VALUES ('a',9223372036854775808);",
            "SELECT missing FROM users;", "SELECT * FROM missing;",
            "SELECT * FROM users WHERE id='wrong';", "SELECT * FROM users WHERE age>2;",
            "SELECT * FROM users WHERE age=2 AND name='a';", "SELECT FROM users;",
            "SELECT * users;", "SELECT * FROM users garbage;", "SELECT * FROM users WHERE;",
            "SELECT * FROM users WHERE id=;", "SELECT * FROM users WHERE id=NULL;",
            "SELECT * FROM users WHERE id=1.5;", "SELECT * FROM users WHERE name='bad;",
            "SELECT *,name FROM users;", "SELECT * FROM users; nonsense;", "", "; ;",
        ]
        for query in invalid:
            with self.subTest(query=query):
                self.assertIn("SQL error", self.sql(query, ok=False).stderr)
        self.assertEqual(self.sql("SELECT * FROM users;")[0]["count"], 0)
        self.assertEqual(self.sql("INSERT INTO users (name,age) VALUES ('ok',-2);")[0]["id"], 1)

    def test_batch_stops_at_error_but_preserves_prior_inserts(self):
        self.ready()
        self.sql("INSERT INTO users (name,age) VALUES ('first',1);"
                 "SELECT no_such_column FROM users;"
                 "INSERT INTO users (name,age) VALUES ('not executed',2);", ok=False)
        self.assertEqual(self.sql("SELECT * FROM users;")[0]["rows"], [[1, "first", 1]])

    def test_configuration_validation_and_sql_file_errors(self):
        self.command("run", "missing.sql", ok=False)
        self.command("init", "--data-dir", self.db, ok=False)
        self.assertFalse((self.cwd / ".mini-db").exists())
        self.ready()
        original = (self.cwd / ".mini-db").read_bytes()
        self.command("init", "--data-dir", self.cwd / "missing", ok=False)
        self.assertEqual((self.cwd / ".mini-db").read_bytes(), original)
        self.command("run", "missing.sql", ok=False)
        sql = self.cwd / "nul.sql"; sql.write_bytes(b"SELECT * FROM users;\x00ignored")
        self.command("run", sql, ok=False)
        (self.db / "tables/users.tbl").write_bytes(b"bad header")
        self.command("run", self.cwd / "nul.sql", ok=False)
        self.command("init", "--data-dir", self.db, ok=False)

    def test_schema_errors(self):
        for schema in ["", "users name:TEXT(4)\n", "../users id:INTEGER\n",
                       "users id:INTEGER name:TEXT(0)\n", "users id:INTEGER id:INTEGER\n",
                       "users id:INTEGER\nusers id:INTEGER\n", "users id:INTEGER x:TEXT(64)junk\n"]:
            with self.subTest(schema=schema):
                (self.db / "schema.txt").write_text(schema)
                self.command("prepare", "--data-dir", self.db, ok=False)

    def test_empty_select_and_string_escaping(self):
        self.ready()
        self.assertEqual(self.sql("SELECT * FROM users;")[0],
                         {"type": "SELECT", "columns": ["id", "name", "age"], "rows": [], "count": 0})
        name = 'a"b\\c\n한글'
        self.sql("INSERT INTO users (name,age) VALUES ('" + name + "',0);")
        self.assertEqual(self.sql("SELECT name FROM users;")[0]["rows"], [[name]])

    def test_shared_library_can_execute_same_engine_without_cli(self):
        self.ready()
        suffix = ".dylib" if sys.platform == "darwin" else ".so"
        lib = ctypes.CDLL(str(BINARY.parent / ("libminidb" + suffix)))
        lib.db_engine_open.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_size_t]
        lib.db_engine_open.restype = ctypes.c_void_p
        lib.db_engine_close.argtypes = [ctypes.c_void_p]
        lib.db_result_free.argtypes = [ctypes.c_void_p]
        lib.db_engine_execute.argtypes = [ctypes.c_void_p, ctypes.c_char_p,
                                         ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        error = ctypes.create_string_buffer(256)
        engine = lib.db_engine_open(str(self.db).encode(), error, len(error))
        self.assertTrue(engine, error.value)
        output = ctypes.c_void_p()
        try:
            self.assertEqual(lib.db_engine_execute(engine, b"SELECT * FROM users;", ctypes.byref(output), None), 0)
            self.assertEqual(json.loads(ctypes.string_at(output))[0]["rows"], [])
        finally:
            lib.db_result_free(output)
            lib.db_engine_close(engine)


if __name__ == "__main__":
    unittest.main()
