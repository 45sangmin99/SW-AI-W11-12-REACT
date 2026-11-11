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
  const componentModule = await fetch(`${baseUrl}/src/engine/component.js`);
  const diffModule = await fetch(`${baseUrl}/src/engine/diff.js`);
  const historyModule = await fetch(`${baseUrl}/src/labs/history.js`);
  const module = await fetch(`${baseUrl}/src/labs/main.js`);
  const patchModule = await fetch(`${baseUrl}/src/engine/patch.js`);
  const patchSummaryModule = await fetch(`${baseUrl}/src/labs/patch-summary.js`);
  const renderModule = await fetch(`${baseUrl}/src/engine/render.js`);
  const todosModule = await fetch(`${baseUrl}/src/labs/todos.js`);
  const vdomModule = await fetch(`${baseUrl}/src/engine/vdom.js`);

  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Virtual DOM 변경 실험/);
  assert.match(html, /Component · State · Hooks/);
  assert.match(html, /Virtual DOM 실습 순서/);
  assert.match(html, /완료 동작을 작성하는 두 방법/);
  assert.match(html, /DOM 직접 갱신 예시/);
  assert.match(html, /FunctionComponent\.hooks/);
  assert.match(html, /id="component-state"/);
  assert.match(html, /id="component-memo"/);
  assert.match(html, /id="effect-output"/);
  assert.match(html, /실제 Patch 명령 보기/);
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
  const routeModule = await fetch(`${baseUrl}/src/logistics/logistics.js`);

  assert.equal(page.status, 200);
  assert.equal(routeModule.status, 200);
  assert.match(routeModule.headers.get("content-type"), /javascript/);
  const html = await page.text();
  assert.match(html, /href="\/">← Mini React 실습으로 돌아가기/);
  assert.match(html, /type="module" src="\/src\/logistics\/logistics\.js"/);
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
