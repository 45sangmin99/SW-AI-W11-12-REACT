import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('engine resource route only serves explicit public runtime files within its root', () => {
  execFileSync('python3', [fileURLToPath(new URL('./dev_server_test.py', import.meta.url))], { stdio: 'pipe' });
});
