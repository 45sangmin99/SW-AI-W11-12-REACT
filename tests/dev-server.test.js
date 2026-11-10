import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDevServer } from "../scripts/dev-server.js";

const server = createDevServer();
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("개선 Phase R5의 행동과 내부 동작 설명을 제공한다", async () => {
  const page = await fetch(`${baseUrl}/`);
  const componentModule = await fetch(`${baseUrl}/src/component.js`);
  const diffModule = await fetch(`${baseUrl}/src/diff.js`);
  const historyModule = await fetch(`${baseUrl}/src/history.js`);
  const module = await fetch(`${baseUrl}/src/main.js`);
  const patchModule = await fetch(`${baseUrl}/src/patch.js`);
  const patchSummaryModule = await fetch(`${baseUrl}/src/patch-summary.js`);
  const renderModule = await fetch(`${baseUrl}/src/render.js`);
  const todosModule = await fetch(`${baseUrl}/src/todos.js`);
  const vdomModule = await fetch(`${baseUrl}/src/vdom.js`);

  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Virtual DOM 변경 실험/);
  assert.match(html, /Component · State · Hooks/);
  assert.match(html, /Virtual DOM 실습 순서/);
  assert.match(html, /Component와 Hook 실습 순서/);
  assert.match(html, /루트 TodoApp만 State를 소유/);
  assert.match(html, /useMemo.*todos나 filter가 바뀔 때만/);
  assert.match(html, /useEffect.*문서 제목에 반영/);
  assert.match(html, /State 변경.*Component 재실행.*Virtual DOM Diff.*실제 DOM Patch/);
  assert.match(html, /최근 사용자 행동과 내부 결과/);
  assert.match(html, /아직 할 일 앱을 조작하지 않았습니다/);
  assert.doesNotMatch(html, /현재 카운터/);
  assert.match(html, /<details class="internals">/);
  assert.match(html, /최근 결과/);
  assert.match(html, /아직 Patch를 적용하지 않았습니다/);
  assert.match(html, /<nav class="site-nav" aria-label="페이지 이동">/);
  assert.match(html, /href="\/" aria-current="page">Virtual DOM 실습/);
  assert.match(html, /href="\/logistics\.html">물류 시뮬레이터 열기/);
  assert.equal(componentModule.status, 200);
  assert.equal(diffModule.status, 200);
  assert.equal(historyModule.status, 200);
  assert.equal(module.status, 200);
  assert.equal(patchModule.status, 200);
  assert.equal(patchSummaryModule.status, 200);
  assert.equal(renderModule.status, 200);
  assert.equal(todosModule.status, 200);
  assert.equal(vdomModule.status, 200);
});

test("물류 시뮬레이터 페이지가 실습으로 돌아가는 링크와 렌더링 모듈을 제공한다", async () => {
  const page = await fetch(`${baseUrl}/logistics.html`);
  const routeModule = await fetch(`${baseUrl}/src/logistics.js`);

  assert.equal(page.status, 200);
  assert.equal(routeModule.status, 200);
  assert.match(routeModule.headers.get("content-type"), /javascript/);
  const html = await page.text();
  assert.match(html, /href="\/">← Mini React 실습으로 돌아가기/);
  assert.match(html, /type="module" src="\/src\/logistics\.js"/);
});

test("삭제된 공지 편집기 경로는 404를 반환한다", async () => {
  const paths = ["/editor.html", "/editor.css", "/src/editor-main.js", "/src/document.js"];
  for (const path of paths) {
    assert.equal((await fetch(baseUrl + path)).status, 404, path);
  }
});

test("등록되지 않은 경로는 404를 반환한다", async () => {
  assert.equal((await fetch(`${baseUrl}/missing`)).status, 404);
});
