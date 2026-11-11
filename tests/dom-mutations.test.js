// MutationObserver로 "실제 DOM이 얼마나 바뀌었는지"를 브라우저가 직접 관측해서 검증한다 (정의서 중점 포인트: 실제 DOM의 변화를 감지하기 위한 브라우저 API).
// 우리 코드가 기록한 변경 목록(lastChanges)이 아니라 브라우저의 독립적인 관측이므로,
// "Patch가 바뀐 노드만 건드렸다 / 전체를 다시 그리지 않았다"의 더 강한 증거가 된다.
import { describe, it, assert, eq, tick } from "./runner.js";
import { mountApp } from "../src/voc/app.js";
import { parseDataset } from "../src/voc/data.js";
import { h, FunctionComponent, useState } from "../src/mini-react.js";
import { render } from "../src/dom.js";
import { diff, REBIND } from "../src/diff.js";
import { patch } from "../src/patch.js";
import { containerToVdom, htmlToVdom } from "../src/vdom.js";

const sandbox = document.createElement("div");
sandbox.style.cssText = "position:fixed;left:-9999px;top:0;width:1100px";
document.body.appendChild(sandbox);

let samplePromise;
const loadSample = () => (samplePromise ??= fetch("./data/inquiries.sample.json").then((r) => r.json()));

const OBSERVE = { subtree: true, childList: true, attributes: true, characterData: true };
/** 지금부터 일어나는 DOM 변경을 모은다. take()는 쌓인 기록을 즉시(동기로) 꺼낸다 */
function watch(root) {
  const observer = new MutationObserver(() => {});
  observer.observe(root, OBSERVE);
  return { take: () => observer.takeRecords(), stop: () => observer.disconnect() };
}

function nodeCount(node) {
  let n = 1;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ALL);
  while (walker.nextNode()) n++;
  return n;
}
/** 실제로 건드려진 노드 수: childList는 추가·삭제된 노드(하위 포함), attributes·characterData는 그 노드 1개 */
function touchedNodes(records) {
  let n = 0;
  for (const r of records) {
    if (r.type === "childList") for (const node of [...r.addedNodes, ...r.removedNodes]) n += nodeCount(node);
    else n += 1;
  }
  return n;
}

async function withApp(fn) {
  const box = document.createElement("div");
  sandbox.appendChild(box);
  try {
    const data = parseDataset(await loadSample());
    const c = mountApp(box, { load: () => Promise.resolve(data) });
    await tick(0);
    await fn({ c, box, $: (s) => box.querySelector(s), $$: (s) => [...box.querySelectorAll(s)] });
  } finally {
    box.remove();
  }
}
const type = (el, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); };
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

describe("MutationObserver: Patch가 실제로 건드린 DOM (Phase 1)", () => {
  it("글자 하나만 바뀌면 브라우저가 본 변경도 글자 한 곳(characterData 1건)뿐이다", () => {
    const box = document.createElement("div");
    box.innerHTML = "<p>안녕</p><ul><li>가</li><li>나</li></ul>";
    const prev = containerToVdom(box);
    const watcher = watch(box);
    patch(box, diff(prev, htmlToVdom("<p>안녕</p><ul><li>가</li><li>다</li></ul>")));
    const records = watcher.take();
    watcher.stop();
    eq(records.length, 1);
    eq(records[0].type, "characterData");
    eq(box.querySelectorAll("li")[1].textContent, "다");
  });

  it("속성 하나만 바뀌면 속성 변경 1건뿐이다", () => {
    const box = document.createElement("div");
    box.innerHTML = '<a href="/a" class="x">링크</a>';
    const prev = containerToVdom(box);
    const watcher = watch(box);
    patch(box, diff(prev, htmlToVdom('<a href="/a" class="y">링크</a>')));
    const records = watcher.take();
    eq(records.length, 1);
    eq(records[0].type, "attributes");
    eq(records[0].attributeName, "class");
  });

  it("바뀐 것이 없으면 브라우저가 관측한 변경은 0건이다", () => {
    const box = document.createElement("div");
    box.innerHTML = "<p>같음</p>";
    const prev = containerToVdom(box);
    const watcher = watch(box);
    patch(box, diff(prev, htmlToVdom("<p>같음</p>")));
    eq(watcher.take().length, 0);
  });
});

describe("MutationObserver: 상태 변경이 만드는 실제 DOM 변경 (Phase 2)", () => {
  it("카운터 버튼을 눌러도 바뀌는 것은 숫자 글자 노드 하나뿐이다", () => {
    const box = document.createElement("div");
    new FunctionComponent(() => {
      const [n, setN] = useState(0);
      return h("div", null, h("h1", null, "제목"), h("button", { onClick: () => setN(n + 1) }, "횟수 ", n), h("p", null, "그대로"));
    }).mount(box);
    const watcher = watch(box);
    click(box.querySelector("button"));
    const records = watcher.take();
    eq(records.length, 1);
    eq(records[0].type, "characterData");
    eq(box.querySelector("button").textContent, "횟수 1");
  });

  it("상태가 그대로면 다시 그려도 DOM 변경은 0건이다 (핸들러 참조 교체는 DOM을 건드리지 않는다)", async () => {
    await withApp(({ c, box }) => {
      const watcher = watch(box);
      c.update();
      assert(c.lastChanges.some((x) => x.type === REBIND), "핸들러 참조는 교체됐다");
      eq(watcher.take().length, 0, "하지만 DOM은 한 건도 바뀌지 않았다");
    });
  });
});

describe("MutationObserver: 문의 이상 탐지 페이지 — 관련 없는 영역은 건드리지 않는다 (R-06, P2-32)", () => {
  it("결과가 달라지지 않는 검색 입력은 입력창의 value 속성만 바꾼다", async () => {
    await withApp(({ box, $ }) => {
      const input = $("input[name=query]");
      const watcher = watch(box);
      type(input, " "); // 앞뒤 공백은 무시되므로 결과가 그대로다
      const records = watcher.take();
      assert(records.length >= 1 && records.length <= 2, `기록 ${records.length}건`);
      assert(records.every((r) => r.type === "attributes" && r.target === input), "입력창 속성 외에는 변경이 없다");
    });
  });

  it("근거 문의 페이지 이동: 바뀐 노드가 모두 근거 문의 영역 안에 있다", async () => {
    await withApp(({ c, box, $, $$ }) => {
      const evidence = $(".evidence");
      const outside = [".app-header", ".filter-bar", ".summary", ".signal-list", ".reason", ".charts"].map((s) => [s, $(s)]);
      const watcher = watch(box);
      click($$(".pager .page").find((b) => b.textContent === "2"));
      const records = watcher.take();
      assert(records.length > 0);
      for (const r of records) {
        assert(evidence.contains(r.target), "근거 문의 영역 안의 변경이어야 한다");
        for (const [name, el] of outside) assert(!el.contains(r.target), `${name} 안은 건드리지 않았다`);
      }
      assert(c.lastChanges.length > 0);
    });
  });

  it("신호 선택: 목록의 강조·상세 영역·진행 현황만 바뀌고 머리글·필터·요약은 건드리지 않는다", async () => {
    await withApp(({ box, $, $$ }) => {
      const untouched = [".app-header", ".filter-bar", ".summary"].map((s) => [s, $(s)]);
      const list = $(".signal-list");
      const detail = $(".signal-detail");
      const progress = $(".progress"); // 정의서 4.3.2: 신호 선택 시 ④ 선택 강조, ⑤ 상세, ⑥ 진행 현황이 갱신된다
      const watcher = watch(box);
      click($$(".alert-card")[1]);
      const records = watcher.take();
      assert(records.length > 0);
      for (const r of records) {
        assert(list.contains(r.target) || detail.contains(r.target) || progress.contains(r.target), "신호 목록, 상세 영역, 진행 현황 안의 변경이어야 한다");
        for (const [name, el] of untouched) assert(!el.contains(r.target), `${name} 안은 건드리지 않았다`);
      }
    });
  });

  it("전체를 다시 그리는 것과 비교: Patch가 건드린 노드는 전체 재생성의 10% 미만이다", async () => {
    await withApp(({ c, box, $$ }) => {
      const total = nodeCount(box);
      const watcher = watch(box);
      click($$(".pager .page").find((b) => b.textContent === "2"));
      const patched = touchedNodes(watcher.take());
      watcher.stop();

      // 같은 화면을 통째로 새로 만들어 바꿔 끼우면 몇 개 노드가 건드려지는가
      const probe = document.createElement("div");
      probe.appendChild(render(c.vdom));
      const probeWatcher = watch(probe);
      probe.replaceChildren(render(c.vdom));
      const rebuilt = touchedNodes(probeWatcher.take());

      assert(patched > 0 && patched < total * 0.25, `Patch가 건드린 노드 ${patched}개 / 화면 전체 ${total}개`);
      assert(rebuilt >= total, `전체 재생성은 화면의 모든 노드(${total}개 이상)를 건드린다: ${rebuilt}개`);
      assert(patched < rebuilt * 0.1, `Patch ${patched}개 vs 전체 재생성 ${rebuilt}개`);
    });
  });

  it("입력창에 포커스가 있는 채로 글자를 쳐도 입력창은 교체되지 않는다 (childList 변경에 입력창이 없다)", async () => {
    await withApp(({ box, $ }) => {
      const input = $("input[name=query]");
      input.focus();
      const watcher = watch(box);
      for (const value of ["쿠", "쿠폰", "쿠폰이"]) type(input, value);
      const records = watcher.take();
      const replaced = records.some((r) => r.type === "childList" && [...r.addedNodes, ...r.removedNodes].some((n) => n === input || n.contains?.(input)));
      assert(!replaced, "입력창이 DOM에서 빠졌다 다시 들어가지 않았다");
      eq(document.activeElement, input);
      assert($("input[name=query]") === input);
    });
  });
});
