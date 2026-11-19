#!/usr/bin/env python3
"""콘솔 기능 시험: 실제 콘솔 프로세스에 입력을 넣고, 출력·종료 코드·재시작 뒤의 데이터를 확인한다.
데이터는 콘솔이 아니라 엔진 CLI(helpers.run)로 따로 읽는다. 콘솔이 보여 준 것과 실제로 저장된 것을 따로 확인하려는 것이다."""
import os, pathlib, pty, select, signal, subprocess, sys, tempfile, termios, time, traceback, unicodedata
from helpers import fixture, run, ROOT

CONSOLE = pathlib.Path(os.environ.get('MDB_CONSOLE', ROOT / 'build/mini-db-console'))
INS = "INSERT INTO characters (name, attack) VALUES ('%s', 1);"


def console(path, text, env=None):
    return subprocess.run([str(CONSOLE), '--data-dir', str(path)], input=text, capture_output=True, text=True,
                          timeout=120, env=dict(os.environ, **(env or {})))


def names(path, table='characters'):
    """엔진 CLI로 실제 저장된 이름을 id 순서로 읽는다"""
    _, out = run(path, f'SELECT name FROM {table} ORDER BY id;')
    return [r[0] for r in out[-1]['rows']]


def fresh():
    folder = tempfile.TemporaryDirectory(prefix='mdb-console-')
    path = pathlib.Path(folder.name)
    fixture(path)
    return folder, path


def display_width(text):
    return sum(0 if unicodedata.combining(ch) else 2 if unicodedata.east_asian_width(ch) in 'WF' else 1 for ch in text)


class Session:
    """입력을 조금씩 넣고 출력을 기다리는 콘솔 프로세스"""

    def __init__(self, path, env=None, pass_fds=()):
        self.p = subprocess.Popen([str(CONSOLE), '--data-dir', str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, env=dict(os.environ, **(env or {})), pass_fds=pass_fds)
        self.buf = ''

    def send(self, text):
        self.p.stdin.write(text.encode())
        self.p.stdin.flush()

    def wait_for(self, needle, timeout=20):
        end = time.time() + timeout
        fd = self.p.stdout.fileno()
        while needle not in self.buf:
            left = end - time.time()
            assert left > 0, ('기다린 출력이 없다', needle, self.buf)
            if select.select([fd], [], [], left)[0]:
                chunk = os.read(fd, 65536)
                assert chunk, ('콘솔이 끝났다', needle, self.buf)
                self.buf += chunk.decode()
        return self.buf


# ------------------------------------------------------------------ 기본 루프와 출력
def test_loop_table_and_affected_rows():
    folder, p = fresh()
    with folder:
        r = console(p, INS % 'a' + '\n' + INS % 'b' + '\nSELECT id, name FROM characters;\n'
                    "UPDATE characters SET attack = 5 WHERE attack = 1;\nDELETE FROM characters WHERE id = 1;\n"
                    "DELETE FROM characters WHERE id = 99;\nSELECT COUNT(*) FROM characters;\n")
        assert r.returncode == 0, (r.stdout, r.stderr)
        assert r.stderr == '', r.stderr
        for text in ['1행이 영향받았습니다 (inserted id=1)', '커밋됨 (DURABLE', '| id | name |', '|  1 | a    |', '|  2 | b    |',
                     '(2행 · 전체 훑기', '2행이 영향받았습니다', '1행이 영향받았습니다 · 커밋됨',
                     '0행이 영향받았습니다 · 변경 없음 (NO_CHANGES)', '| count |', '|     1 |']:
            assert text in r.stdout, (text, r.stdout)
        assert names(p) == ['b']


def test_index_is_reported():
    folder, p = fresh()
    with folder:
        r = console(p, INS % 'a' + '\nSELECT * FROM characters WHERE id = 1;\nSELECT * FROM characters WHERE attack = 1;\n')
        assert '(1행 · 인덱스 조회' in r.stdout and '(1행 · 전체 훑기' in r.stdout, r.stdout


def test_errors_do_not_stop_the_console():
    folder, p = fresh()
    with folder:
        r = console(p, "SELEC * FROM characters;\nSELECT * FROM nothing;\nSELECT nope FROM characters;\n"
                    "INSERT INTO characters (name, attack) VALUES (NULL, 1);\n" + INS % 'after errors' + '\n')
        assert names(p) == ['after errors']  # 오류가 난 뒤에도 다음 문장이 실행됐다
        for text in ['오류 [ERR_SYNTAX]', '오류 [ERR_UNKNOWN_TABLE]', '.tables', '오류 [ERR_UNKNOWN_COLUMN]']:
            assert text in r.stderr, (text, r.stderr)
        assert '  SELEC * FROM characters;\n  ^' in r.stderr, r.stderr  # 오류 위치를 가리킨다
        assert r.returncode == 1  # 스크립트로 쓸 때는 오류가 있었음을 종료 코드로 알린다


def test_null_is_not_supported_and_empty_string_is_not_null():
    folder, p = fresh()
    with folder:
        r = console(p, "INSERT INTO characters (name, attack) VALUES ('', 1);\nSELECT * FROM characters;\n")
        assert 'NULL' not in r.stdout, r.stdout  # 빈 문자열을 NULL 로 보여 주지 않는다
        assert '|  1 |      |      1 |' in r.stdout, r.stdout


# ------------------------------------------------------------------ 문장 끊기
def test_semicolon_in_string_and_multiline():
    folder, p = fresh()
    with folder:
        r = console(p, "INSERT INTO characters (name, attack) VALUES ('a;b', 1); INSERT INTO characters\n(name,\nattack) VALUES ('O''Brien; \"x\"', 2);\n"
                    ";;\n   \n")
        assert r.returncode == 0 and r.stderr == '', (r.stdout, r.stderr)  # ;; 와 빈 줄은 오류가 아니다
        assert names(p) == ['a;b', 'O\'Brien; "x"'], names(p)


def test_incomplete_statement_is_not_run():
    folder, p = fresh()
    with folder:
        r = console(p, INS % 'done' + '\n' + (INS % 'half').rstrip(';'))
        assert names(p) == ['done']
        assert '세미콜론으로 끝나지 않은 입력은 실행하지 않았습니다' in r.stderr and r.returncode == 1


def test_too_long_statement_is_skipped_and_console_continues():
    folder, p = fresh()
    with folder:
        r = console(p, "INSERT INTO characters (name, attack) VALUES ('" + 'a' * 5000 + "', 1);\n" + INS % 'ok' + '\n')
        assert '한도' in r.stderr, r.stderr
        assert names(p) == ['ok']


def test_nul_in_input_is_ignored():
    folder, p = fresh()
    with folder:
        r = console(p, 'SELECT \x00 1;\n' + INS % 'after nul' + '\n')
        assert 'NUL' in r.stderr and names(p) == ['after nul'], (r.stderr, names(p))


# ------------------------------------------------------------------ 종료 명령과 . 명령
def test_quit_commands_stop_reading():
    for quit_command in ['.quit', '.exit', '\\q', '.QUIT', '  .quit  ']:
        folder, p = fresh()
        with folder:
            r = console(p, INS % 'before' + f'\n{quit_command}\n' + INS % 'after' + '\n')
            assert r.returncode == 0 and r.stderr == '', (quit_command, r.stdout, r.stderr)
            assert names(p) == ['before'], (quit_command, names(p))


def test_dot_command_inside_a_statement_is_sql_not_a_command():
    folder, p = fresh()
    with folder:
        r = console(p, 'SELECT\n.quit\n;\n' + INS % 'still running' + '\n')
        assert '오류 [ERR_SYNTAX]' in r.stderr  # .quit 가 SQL 의 일부로 읽혀서 문법 오류가 났다
        assert names(p) == ['still running']  # 그리고 콘솔은 끝나지 않았다


def test_dot_commands():
    folder, p = fresh()
    with folder:
        r = console(p, '.help\n.tables\n.schema characters\n.schema nope\n.schema ../x\n.foo\n' + INS % 'x' + '\n')
        assert '.quit' in r.stdout and '\\q' in r.stdout and 'NULL이 없습니다' in r.stdout
        assert 'characters\nitems\n' in r.stdout
        assert 'characters\n  id INT AUTO\n  name VARCHAR(80)\n  attack INT\n' in r.stdout, r.stdout
        assert "테이블 'nope'" in r.stderr and '이름이 올바르지 않습니다' in r.stderr and '알 수 없는 명령입니다: .foo' in r.stderr
        assert names(p) == ['x']


# ------------------------------------------------------------------ 트랜잭션
def test_transactions():
    folder, p = fresh()
    with folder:
        r = console(p, 'BEGIN;\n' + INS % 'rolled back' + '\nSELECT name FROM characters;\nROLLBACK;\n'
                    'BEGIN;\n' + INS % 'kept' + '\nCOMMIT;\nBEGIN;\nCOMMIT;\n')
        assert r.returncode == 0 and r.stderr == '', (r.stdout, r.stderr)
        for text in ['트랜잭션을 시작했습니다', '아직 커밋되지 않음 (STAGED', '| rolled back |', '롤백했습니다', '커밋했습니다', '커밋할 변경이 없었습니다 (NO_CHANGES)']:
            assert text in r.stdout, (text, r.stdout)
        assert names(p) == ['kept']


def test_open_transaction_is_discarded_on_quit_and_eof():
    for ending in ['.quit\n', '']:  # .quit 와 입력 끝(EOF)
        folder, p = fresh()
        with folder:
            r = console(p, 'BEGIN;\n' + INS % 'not committed' + '\n' + ending)
            assert '커밋하지 않은 트랜잭션이 있어서 변경은 버려집니다' in r.stdout, r.stdout
            assert names(p) == [], names(p)


def test_failed_transaction_needs_rollback():
    folder, p = fresh()
    with folder:
        r = console(p, 'BEGIN;\n' + INS % 'x' + '\nSELEC bad;\n' + INS % 'blocked' + '\nROLLBACK;\n' + INS % 'ok' + '\n')
        assert 'FAILED 상태입니다' in r.stderr and 'ERR_FAILED_TRANSACTION' in r.stderr, r.stderr
        assert names(p) == ['ok']  # 실패한 트랜잭션의 변경은 모두 버려지고, ROLLBACK 뒤에는 다시 쓸 수 있다


# ------------------------------------------------------------------ 표 모양과 글자
def test_wide_characters_are_aligned():
    folder, p = fresh()
    with folder:
        values = ['총웨', 'abc', '한글 mixed 테스트', 'e\u0301', '😀 웃음', 'a\tb', '줄\n바꿈', '']
        script = ''.join("INSERT INTO characters (name, attack) VALUES ('%s', %d);\n" % (v, i) for i, v in enumerate(values))
        r = console(p, script + 'SELECT id, name, attack FROM characters;\n')
        table = [line for line in r.stdout.splitlines() if line.startswith(('|', '+'))]
        assert len(table) == len(values) + 4, r.stdout
        widths = {display_width(line) for line in table}
        assert len(widths) == 1, ('줄 폭이 다르다', widths, '\n'.join(table))
        assert '줄\\n바꿈' in r.stdout and 'a\\tb' in r.stdout  # 제어 문자는 표를 깨지 않게 \n \t 로 보인다
        # 숫자 열은 오른쪽, 문자열 열은 왼쪽으로 맞춘다
        assert '|  2 | abc' in r.stdout and 'attack |' in table[1]  # abc 는 두 번째 행이라 id 가 2다


def test_text_is_stored_exactly_as_typed():
    folder, p = fresh()
    with folder:
        values = ["O'Brien", '한글 · “따옴표” — 줄표', '😀', 'a;b', '  앞뒤 공백  ', 'back\\slash']
        script = ''.join("INSERT INTO characters (name, attack) VALUES ('%s', 1);\n" % v.replace("'", "''") for v in values)
        console(p, script)
        assert names(p) == values, names(p)


def test_many_rows_and_result_limit_error():
    folder, p = fresh()
    with folder:
        script = 'BEGIN;\n' + ''.join(INS % 'row' + '\n' for _ in range(10001)) + 'COMMIT;\n'
        r = console(p, script + 'SELECT * FROM characters;\nSELECT COUNT(*) FROM characters;\n')
        assert 'ERR_LIMIT_EXCEEDED' in r.stderr, r.stderr[-300:]  # 결과가 한도를 넘으면 조용히 자르지 않고 오류다
        assert '| 10001 |' in r.stdout  # 오류 뒤에도 콘솔은 계속 동작했다


# ------------------------------------------------------------------ 실행 중인 프로세스
def test_directory_is_locked_by_one_console():
    folder, p = fresh()
    with folder:
        a = Session(p)
        try:
            a.send('.tables\n')
            a.wait_for('characters')
            b = console(p, '.tables\n')
            assert b.returncode == 1 and '데이터 폴더를 열 수 없습니다' in b.stderr, (b.returncode, b.stderr)
            a.send(INS % 'from a' + '\n')  # 먼저 켠 콘솔은 영향받지 않는다
            a.wait_for('DURABLE')
            a.send('.quit\n')
            assert a.p.wait(timeout=20) == 0
        finally:
            if a.p.poll() is None:
                a.p.kill()
        assert names(p) == ['from a']


def test_sigkill_then_rerun_recovers_safely():
    """콘솔을 강제 종료(SIGKILL)해도 확정된 변경은 남고, 확정 못 한 변경은 사라지며, 다시 실행하면 정상 동작한다"""
    folder, p = fresh()
    with folder:
        a = Session(p)
        try:
            a.send(INS % 'durable' + '\n')
            a.wait_for('DURABLE')
            a.send('BEGIN;\n' + INS % 'staged only' + '\n')
            a.wait_for('STAGED')
            a.p.kill()  # 트랜잭션이 열린 채로 프로세스를 죽인다
            a.p.wait()
            assert a.p.returncode == -signal.SIGKILL
        finally:
            if a.p.poll() is None:
                a.p.kill()
        assert names(p) == ['durable'], names(p)
        r = console(p, 'SELECT name FROM characters;\n' + INS % 'after restart' + '\n')  # 같은 폴더로 다시 실행
        assert r.returncode == 0 and '| durable |' in r.stdout and 'DURABLE' in r.stdout, (r.stdout, r.stderr)
        assert names(p) == ['durable', 'after restart']


def crash_at(path, sql, fault):
    """엔진의 장애 주입 지점에서 멈춘 콘솔을 외부에서 SIGKILL 한다 (tests/crash.py 와 같은 방식)"""
    read_fd, write_fd = os.pipe()
    env = dict(os.environ, MDB_FAILPOINT=fault, MDB_FAILPOINT_ACTION='pause', MDB_FAILPOINT_READY_FD=str(write_fd))
    proc = subprocess.Popen([str(CONSOLE), '--data-dir', str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, pass_fds=(write_fd,))
    os.close(write_fd)
    try:
        proc.stdin.write(sql.encode())
        proc.stdin.flush()
        ready = select.select([read_fd], [], [], 30)[0]
        assert ready and os.read(read_fd, 1) == b'R', (fault, '장애 지점에 닿지 못했다')
        proc.kill()
        proc.wait(timeout=10)
        assert proc.returncode == -signal.SIGKILL
    finally:
        os.close(read_fd)
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_crash_in_the_middle_of_a_commit():
    for fault, expected in [('wal_partial', False), ('after_commit_sync', True), ('after_csv_rename', True)]:
        folder, p = fresh()
        with folder:
            console(p, INS % 'confirmed' + '\n')
            crash_at(p, INS % 'crash' + '\n', fault)
            for _ in range(2):  # 두 번 다시 실행해도(반복 복구) 같은 결과다
                r = console(p, 'SELECT name FROM characters;\n')
                assert r.returncode == 0, (fault, r.stderr)
                assert names(p) == (['confirmed', 'crash'] if expected else ['confirmed']), (fault, names(p))
            r = console(p, INS % 'later' + '\n')  # 복구된 뒤에도 정상 동작한다
            assert 'DURABLE' in r.stdout and names(p)[-1] == 'later'


def test_unknown_commit_blocks_sql_and_rerun_recovers():
    folder, p = fresh()
    with folder:
        run(p, INS % 'confirmed')
        r = console(p, INS % 'maybe' + '\nSELECT * FROM characters;\n.quit\n', env={'MDB_IO_FAIL': 'wal_fsync'})
        assert 'UNKNOWN' in r.stderr and '복구가 필요' in r.stderr, r.stderr
        assert '엔진이 복구를 요구해서 SQL을 실행하지 않습니다' in r.stderr  # 이후 SQL 은 보내지 않는다
        assert '| name' not in r.stdout and r.returncode == 1
        assert names(p) in (['confirmed'], ['confirmed', 'maybe']), names(p)  # 재시작하면 어느 한쪽으로 일관되게 복구된다
        r = console(p, INS % 'again' + '\n')
        assert 'DURABLE' in r.stdout and names(p)[-1] == 'again'


def test_io_error_tells_whether_it_was_saved():
    """오류로 보여도 저장됐거나(다시 실행하면 중복) 저장되지 않았다는 사실을 한국어로 알려 준다"""
    folder, p = fresh()
    with folder:
        r = console(p, INS % 'durable but error' + '\nSELECT 1;\n', env={'MDB_IO_FAIL': 'applied_write'})
        assert '커밋은 확정됐습니다 (DURABLE' in r.stderr and '다시 실행하지 마세요' in r.stderr, r.stderr
        assert names(p) == ['durable but error']  # 말한 대로 실제로 저장되어 있다
    folder, p = fresh()
    with folder:
        r = console(p, INS % 'not saved' + '\n', env={'MDB_IO_FAIL': 'csv_write'})
        assert '저장되지 않았습니다 (NOT_COMMITTED)' in r.stderr and 'DURABLE' not in r.stderr, r.stderr
        assert names(p) == []  # 말한 대로 실제로 저장되지 않았다
        r = console(p, "SELEC;\n")  # 일반 오류에는 붙지 않는다
        assert '저장되지 않았습니다' not in r.stderr and 'NOT_COMMITTED' not in r.stderr, r.stderr


# ------------------------------------------------------------------ 터미널(pty)에서의 대화
class Terminal:
    def __init__(self, path):
        self.master, slave = pty.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO  # 입력한 글자가 출력에 되돌아오지 않게 한다
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        self.p = subprocess.Popen([str(CONSOLE), '--data-dir', str(path)], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
        os.close(slave)
        self.buf, self.pos = '', 0

    def write(self, data):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())

    def expect(self, needle, timeout=10):
        end = time.time() + timeout
        while needle not in self.buf[self.pos:]:
            left = end - time.time()
            assert left > 0, ('기다린 출력이 없다', needle, self.buf[self.pos:])
            if select.select([self.master], [], [], left)[0]:
                try:
                    self.buf += os.read(self.master, 4096).decode('utf-8', 'replace')
                except OSError:
                    break
        assert needle in self.buf[self.pos:], ('기다린 출력이 없다', needle, self.buf[self.pos:])
        self.pos += self.buf[self.pos:].index(needle) + len(needle)

    def close(self):
        if self.p.poll() is None:
            self.p.kill()
            self.p.wait()
        os.close(self.master)


def test_interactive_prompts_ctrl_c_and_quit():
    folder, p = fresh()
    with folder:
        t = Terminal(p)
        try:
            t.expect('mydb> ')
            t.write('SELECT\n')
            t.expect('   ...> ')  # 문장이 끝나지 않으면 이어 쓰라는 프롬프트
            time.sleep(0.3)
            t.p.send_signal(signal.SIGINT)  # Ctrl-C: 쓰던 입력만 취소하고 계속한다
            t.expect('입력을 취소했습니다')
            t.expect('mydb> ')
            t.write(INS % 'x' + '\n')
            t.expect('DURABLE')  # 취소한 SELECT 가 남아서 문법 오류가 나지 않았다
            t.expect('mydb> ')
            t.write('BEGIN;\n')
            t.expect('mydb(tx)> ')  # 트랜잭션이 열려 있으면 프롬프트가 바뀐다
            t.write('SELEC;\n')
            t.expect('mydb(tx FAILED)> ')
            t.write('ROLLBACK;\n')
            t.expect('mydb> ')
            t.write('\\q\n')
            assert t.p.wait(timeout=10) == 0  # 대화형은 오류가 있었어도 정상 종료다
        finally:
            t.close()
        assert names(p) == ['x']


def test_interactive_ctrl_d_exits():
    folder, p = fresh()
    with folder:
        t = Terminal(p)
        try:
            t.expect('mydb> ')
            t.write(b'\x04')  # Ctrl-D
            assert t.p.wait(timeout=10) == 0
        finally:
            t.close()


def main():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith('test_') and callable(f)]
    failed = []
    for name, fn in tests:
        try:
            fn()
            print('PASS', name)
        except Exception:
            failed.append(name)
            print('FAIL', name)
            traceback.print_exc()
    print(f'{len(tests) - len(failed)}/{len(tests)} passed')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
