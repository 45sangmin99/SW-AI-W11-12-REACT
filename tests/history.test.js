import { describe, it, assert, eq, deepEq, throws, tick, isDeepFrozen } from "./runner.js";
import { htmlToVdom } from "../src/vdom.js";
import { StateHistory } from "../src/history.js";

const v = (html) => htmlToVdom(html);

describe("StateHistory", () => {
  it("처음에는 현재 상태가 초기 상태이고 이동할 수 없다", () => {
    const first = v("<p>1</p>");
    const h = new StateHistory(first);
    eq(h.current, first);
    assert(!h.canBack);
    assert(!h.canForward);
  });
  it("첫 상태에서 뒤로가기: null을 반환하고 이동하지 않는다", () => {
    const first = v("<p>1</p>");
    const h = new StateHistory(first);
    eq(h.back(), null);
    eq(h.current, first);
  });
  it("마지막 상태에서 앞으로가기: null을 반환하고 이동하지 않는다", () => {
    const h = new StateHistory(v("<p>1</p>"));
    const second = v("<p>2</p>");
    h.push(second);
    eq(h.forward(), null);
    eq(h.current, second);
  });
  it("push 후 뒤로/앞으로가기로 저장된 상태를 오간다", () => {
    const a = v("<p>a</p>"), b = v("<p>b</p>"), c = v("<p>c</p>");
    const h = new StateHistory(a);
    h.push(b);
    h.push(c);
    eq(h.back(), b);
    eq(h.back(), a);
    assert(!h.canBack);
    eq(h.forward(), b);
    eq(h.forward(), c);
    assert(!h.canForward);
  });
  it("과거 상태에서 push하면 이후(미래) 기록이 사라진다", () => {
    const a = v("<p>a</p>"), b = v("<p>b</p>"), c = v("<p>c</p>"), d = v("<p>d</p>");
    const h = new StateHistory(a);
    h.push(b);
    h.push(c);
    h.back(); // b
    h.push(d);
    assert(!h.canForward);
    eq(h.current, d);
    eq(h.back(), b); // c는 사라지고 b -> d 로 이어진다
    eq(h.forward(), d);
  });
  it("저장된 스냅샷은 깊게 얼려져 있다", () => {
    const h = new StateHistory(v(`<ul><li class="a">1</li></ul>`));
    assert(isDeepFrozen(h.current));
  });
  it("저장된 스냅샷을 수정하려 하면 예외가 나고 내용은 그대로", () => {
    const first = v("<p>a</p>");
    const before = JSON.stringify(first);
    const h = new StateHistory(first);
    throws(() => (h.current.children[0].children[0].value = "HACK"));
    throws(() => h.current.children.push({}));
    h.push(v("<p>b</p>"));
    eq(JSON.stringify(h.back()), before);
  });
});

// ---- 페이지 수준: index.html을 iframe으로 열어 실제 버튼·입력으로 검증 ----
async function loadPage() {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:absolute;left:-9999px;width:800px;height:600px";
  // 이 테스트 파일(tests/)의 위치 기준으로 index.html을 찾는다. "../index.html"처럼 문서 주소 기준으로 적으면
  // 서버를 Mini_react의 상위 폴더에서 띄웠을 때 404가 난다
  frame.src = new URL("../index.html", import.meta.url).href;
  document.body.appendChild(frame);
  await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  await tick(20);
  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  const $ = (id) => doc.getElementById(id);
  return {
    frame,
    real: $("real-root"),
    test: $("test-root"),
    code: $("test-code"),
    patchBtn: $("patch-btn"),
    back: $("back-btn"),
    forward: $("forward-btn"),
    edit(html) {
      this.code.value = html;
      this.code.dispatchEvent(new win.Event("input"));
    },
    destroy() {
      frame.remove();
    },
  };
}

describe("History: Phase 1 페이지 동작", () => {
  it("로드 직후 두 영역이 같고, 뒤로/앞으로 버튼이 비활성화", async () => {
    const p = await loadPage();
    try {
      eq(p.real.innerHTML, p.test.innerHTML);
      assert(p.back.disabled && p.forward.disabled);
    } finally { p.destroy(); }
  });

  it("변경 없는 Patch는 기록을 추가하지 않는다", async () => {
    const p = await loadPage();
    try {
      p.patchBtn.click();
      p.patchBtn.click();
      assert(p.back.disabled, "기록이 추가되지 않아야 한다");
      p.edit("<p>새 내용</p>");
      p.patchBtn.click();
      p.patchBtn.click(); // 같은 내용으로 다시 Patch
      p.back.click();
      assert(p.back.disabled, "기록은 초기 + 1개뿐이어야 한다");
    } finally { p.destroy(); }
  });

  it("Patch 후 실제 영역이 테스트 영역과 같아지고, 바뀌지 않은 노드는 유지된다", async () => {
    const p = await loadPage();
    try {
      const h1 = p.real.querySelector("h1");
      const li = p.real.querySelector("li");
      p.edit(p.code.value.replace("Mini React", "Changed"));
      eq(p.real.querySelector("h1").textContent, "Mini React", "Patch 전에는 실제 영역이 그대로");
      p.patchBtn.click();
      eq(p.real.innerHTML, p.test.innerHTML);
      eq(p.real.querySelector("h1"), h1);
      eq(p.real.querySelector("li"), li);
      eq(h1.textContent, "Changed");
    } finally { p.destroy(); }
  });

  it("뒤로가기/앞으로가기는 두 영역(과 코드 칸)을 함께 바꾼다", async () => {
    const p = await loadPage();
    try {
      const original = p.real.innerHTML;
      p.edit("<p>두번째</p>");
      p.patchBtn.click();
      p.back.click();
      eq(p.real.innerHTML, original);
      eq(p.test.innerHTML, original);
      eq(p.code.value, original);
      assert(p.back.disabled, "첫 상태에서는 뒤로가기 비활성화");
      p.forward.click();
      eq(p.real.innerHTML, "<p>두번째</p>");
      eq(p.test.innerHTML, "<p>두번째</p>");
      assert(p.forward.disabled, "마지막 상태에서는 앞으로가기 비활성화");
    } finally { p.destroy(); }
  });

  it("과거 상태에서 Patch하면 미래 기록이 사라진다", async () => {
    const p = await loadPage();
    try {
      const original = p.real.innerHTML;
      p.edit("<p>A</p>"); p.patchBtn.click();
      p.edit("<p>B</p>"); p.patchBtn.click();
      p.back.click(); // A
      p.edit("<p>C</p>"); p.patchBtn.click();
      assert(p.forward.disabled, "미래 기록(B)이 사라져야 한다");
      p.back.click();
      eq(p.real.innerHTML, "<p>A</p>");
      p.back.click();
      eq(p.real.innerHTML, original);
      p.forward.click(); p.forward.click();
      eq(p.real.innerHTML, "<p>C</p>");
    } finally { p.destroy(); }
  });

  it("테스트 영역에 <script>·주석·위험한 속성을 넣어도 실행·반영되지 않는다", async () => {
    const p = await loadPage();
    try {
      p.frame.contentWindow.__pwn = 0;
      p.edit(`<script>window.__pwn=1<\/script><!--c--><a href="javascript:window.__pwn=2">x</a><p>ok</p>`);
      p.patchBtn.click();
      p.real.querySelector("a").click();
      eq(p.frame.contentWindow.__pwn, 0);
      assert(!p.real.querySelector("a").hasAttribute("href"));
      eq(p.real.querySelectorAll("script").length, 0);
      deepEq([...p.real.childNodes].map((n) => n.nodeType), [1, 1]);
    } finally { p.destroy(); }
  });
});
