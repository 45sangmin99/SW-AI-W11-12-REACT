import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("README가 실행 방법과 핵심 모듈을 설명한다", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

  assert.match(readme, /node --run dev/);
  assert.match(readme, /node --run test/);
  assert.match(readme, /src\/engine\/diff\.js/);
  assert.match(readme, /src\/engine\/component\.js/);
  assert.match(readme, /useState/);
  assert.match(readme, /useEffect/);
  assert.match(readme, /useMemo/);
});
