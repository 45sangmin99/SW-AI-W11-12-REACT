import { describe, it, assert, eq, deepEq, throws, mk, assertMirrors } from "./runner.js";
import { containerToVdom, htmlToVdom, domToVdom } from "../src/vdom.js";
import { diff } from "../src/diff.js";
import { patch } from "../src/patch.js";
import { render, isUnsafeAttr } from "../src/dom.js";

/** before HTML을 DOM으로 만들고 after로 패치한다. 결과를 돌려준다 */
function run(before, after) {
  const dom = mk(before);
  const oldV = containerToVdom(dom);
  const newV = htmlToVdom(after);
  const changes = diff(oldV, newV);
  const root = patch(dom, changes);
  return { dom, changes, newV, root };
}
const types = (changes) => changes.map((c) => c.type);

describe("Diff: 변경 목록", () => {
  it("같은 트리면 변경이 없다", () => {
    deepEq(diff(htmlToVdom("<p class='a'>x</p>t"), htmlToVdom("<p class='a'>x</p>t")), []);
  });
  it("CREATE: 자식이 늘면 끝에 추가", () => {
    deepEq(types(diff(htmlToVdom("<ul><li>1</li></ul>"), htmlToVdom("<ul><li>1</li><li>2</li></ul>"))), ["CREATE"]);
  });
  it("REMOVE: 자식이 줄면 뒤에서부터 삭제 (인덱스가 밀리지 않게)", () => {
    const c = diff(htmlToVdom("<p>a</p><p>b</p><p>c</p>"), htmlToVdom("<p>a</p>"));
    deepEq(c.map((x) => x.path), [[2], [1]]);
  });
  it("REPLACE: 태그가 다르면 교체", () => {
    deepEq(types(diff(htmlToVdom("<p>a</p>"), htmlToVdom("<div>a</div>"))), ["REPLACE"]);
  });
  it("REPLACE: 텍스트 노드 -> 요소", () => {
    deepEq(types(diff(htmlToVdom("a"), htmlToVdom("<b>a</b>"))), ["REPLACE"]);
  });
  it("UPDATE_PROPS: 추가·변경·삭제된 속성을 구분", () => {
    const [c] = diff(htmlToVdom(`<p a="1" b="2">x</p>`), htmlToVdom(`<p a="9" c="3">x</p>`));
    eq(c.type, "UPDATE_PROPS");
    deepEq(c.set, { a: "9", c: "3" });
    deepEq(c.remove, ["b"]);
  });
  it("UPDATE_TEXT: 텍스트 값 변경", () => {
    const [c] = diff(htmlToVdom("<p>a</p>"), htmlToVdom("<p>b</p>"));
    eq(c.type, "UPDATE_TEXT");
    eq(c.value, "b");
  });
  it("경로는 루트부터의 자식 인덱스", () => {
    const [c] = diff(htmlToVdom("<div><p>a</p><ul><li>1</li></ul></div>"), htmlToVdom("<div><p>a</p><ul><li>2</li></ul></div>"));
    deepEq(c.path, [0, 1, 0, 0]);
  });
  it("순서가 바뀌면 이동이 아니라 각 위치의 수정으로 나타난다 (key 없는 인덱스 비교)", () => {
    const c = diff(htmlToVdom("<ul><li>A</li><li>B</li><li>C</li></ul>"), htmlToVdom("<ul><li>C</li><li>B</li><li>A</li></ul>"));
    deepEq(types(c), ["UPDATE_TEXT", "UPDATE_TEXT"]);
  });
});

describe("Patch: 실제 DOM 반영", () => {
  it("CREATE", () => {
    const { dom } = run("<ul><li>1</li></ul>", "<ul><li>1</li><li>2</li></ul>");
    eq(dom.innerHTML, "<ul><li>1</li><li>2</li></ul>");
  });
  it("REMOVE (여러 개)", () => {
    const { dom } = run("<p>a</p><p>b</p><p>c</p>", "<p>a</p>");
    eq(dom.innerHTML, "<p>a</p>");
  });
  it("REPLACE (타입 교체)", () => {
    const { dom } = run("<p>a</p><i>x</i>", "<div>a</div><i>x</i>");
    eq(dom.innerHTML, "<div>a</div><i>x</i>");
  });
  it("UPDATE_PROPS (추가·변경·삭제)", () => {
    const { dom } = run(`<p a="1" b="2">x</p>`, `<p a="9" c="3">x</p>`);
    const p = dom.firstChild;
    eq(p.getAttribute("a"), "9");
    eq(p.getAttribute("c"), "3");
    assert(!p.hasAttribute("b"));
  });
  it("UPDATE_TEXT", () => {
    eq(run("<p>a</p>", "<p>b</p>").dom.innerHTML, "<p>b</p>");
  });
  it("빈 DOM -> 내용, 내용 -> 빈 DOM", () => {
    eq(run("", "<p>a</p>text").dom.innerHTML, "<p>a</p>text");
    eq(run("<p>a</p>text", "").dom.innerHTML, "");
  });
  it("깊은 곳의 변경도 정확히 반영", () => {
    const { dom } = run("<div><p>a</p><ul><li>1</li></ul></div>", "<div><p>a</p><ul><li>2</li></ul></div>");
    eq(dom.innerHTML, "<div><p>a</p><ul><li>2</li></ul></div>");
  });
  it("패치 후 DOM이 새 Virtual DOM과 노드 단위로 일치", () => {
    const { dom, newV } = run(`<h1>t</h1><ul><li>1</li><li>2</li><li>3</li></ul>x`, `<h1 id="a">T</h1><ul><li>1</li></ul><p>y</p>`);
    assertMirrors(dom, newV);
  });
  it("변경되지 않은 노드는 같은 DOM 노드로 유지된다", () => {
    const dom = mk("<h1>t</h1><ul><li>1</li><li>2</li></ul><p>p</p>");
    const [h1, ul, p] = dom.children;
    const [li1, li2] = ul.children;
    patch(dom, diff(containerToVdom(dom), htmlToVdom("<h1>t</h1><ul><li>1</li><li>2</li><li>3</li></ul><p>P</p>")));
    eq(dom.children[0], h1);
    eq(dom.children[1], ul);
    eq(ul.children[0], li1);
    eq(ul.children[1], li2);
    eq(dom.children[2], p); // 텍스트만 바뀐 p도 요소는 그대로
  });
  it("속성만 바뀐 요소도 같은 DOM 노드", () => {
    const dom = mk(`<p class="a">x</p>`);
    const p = dom.firstChild;
    patch(dom, diff(containerToVdom(dom), htmlToVdom(`<p class="b">x</p>`)));
    eq(dom.firstChild, p);
  });
  it("순서 변경은 노드를 옮기지 않고 위치별로 수정한다 (노드 동일성 보장 없음)", () => {
    const dom = mk("<ul><li>A</li><li>B</li></ul>");
    const [first, second] = dom.querySelectorAll("li");
    patch(dom, diff(containerToVdom(dom), htmlToVdom("<ul><li>B</li><li>A</li></ul>")));
    eq(dom.innerHTML, "<ul><li>B</li><li>A</li></ul>");
    eq(dom.querySelectorAll("li")[0], first); // 첫 번째 li 요소가 'B'로 바뀐 것이지 이동한 것이 아니다
    eq(dom.querySelectorAll("li")[1], second);
  });
  it("루트가 교체되면 새 루트를 반환한다", () => {
    const host = document.createElement("div");
    const old = document.createElement("p");
    old.textContent = "a";
    host.appendChild(old);
    const next = mk("<section>b</section>").firstChild;
    const root = patch(old, diff(domToVdom(old), domToVdom(next)));
    eq(root.localName, "section");
    eq(host.firstChild, root);
  });
  it("존재하지 않는 경로면 예외", () => {
    throws(() => patch(mk("<p>a</p>"), [{ type: "REMOVE", path: [5] }]), /경로/);
  });
  it("연속 패치를 거쳐도 DOM과 Virtual DOM이 일치", () => {
    const dom = mk("<p>a</p>");
    let v = containerToVdom(dom);
    for (const html of ["<p>a</p><p>b</p>", "<div>x<b>y</b></div>", "", "t<i>1</i>2"]) {
      const next = htmlToVdom(html);
      patch(dom, diff(v, next));
      v = next;
      assertMirrors(dom, v);
    }
  });
});

describe("Patch: <template> 내부", () => {
  const content = (dom) => dom.querySelector("template").content;

  it("template 안의 추가·텍스트 변경·삭제·교체가 content에 반영된다", () => {
    const dom = mk("<template><p>a</p><b>b</b><i>i</i></template><p>after</p>");
    const after = dom.lastChild;
    const oldV = containerToVdom(dom);
    const newV = htmlToVdom("<template><p>A</p><u>b</u></template><p>after</p>");
    patch(dom, diff(oldV, newV));
    eq(dom.querySelector("template").innerHTML, "<p>A</p><u>b</u>");
    eq(dom.lastChild, after); // template 밖의 노드는 그대로
    assertMirrors(dom, newV);
  });
  it("template 안에 새 자식을 추가해도 템플릿 요소의 childNodes에는 붙지 않는다", () => {
    const dom = mk("<template></template>");
    patch(dom, diff(containerToVdom(dom), htmlToVdom("<template><p>x</p></template>")));
    eq(dom.querySelector("template").childNodes.length, 0);
    eq(content(dom).childNodes.length, 1);
  });
  it("template 안의 변경 없는 노드는 같은 DOM 노드로 유지", () => {
    const dom = mk("<template><p>a</p><p>b</p></template>");
    const p0 = content(dom).firstChild;
    patch(dom, diff(containerToVdom(dom), htmlToVdom("<template><p>a</p><p>B</p></template>")));
    eq(content(dom).firstChild, p0);
  });
  it("Phase 2 h()로 만든 template도 content에 렌더링된다", async () => {
    const { h, FunctionComponent } = await import("../src/mini-react.js");
    const box = document.createElement("div");
    new FunctionComponent(() => h("div", null, h("template", null, h("p", null, "t")))).mount(box);
    eq(box.querySelector("template").content.firstChild.localName, "p");
  });
});

describe("DOM 반영 규칙: 이벤트 핸들러와 차단 속성", () => {
  const click = (el) => el.dispatchEvent(new MouseEvent("click"));
  const btn = (props) => ({ type: "element", tag: "button", props, children: [] });
  const wrap = (child) => ({ type: "element", tag: "div", props: {}, children: [child] });

  it("핸들러를 교체하면 이전 핸들러는 지워지고 새 핸들러만 한 번 실행", () => {
    let a = 0, b = 0;
    const root = render(wrap(btn({ onclick: () => a++ })));
    const v0 = wrap(btn({ onclick: () => a++ }));
    const v1 = wrap(btn({ onclick: () => b++ }));
    patch(root, diff(v0, v1));
    click(root.firstChild);
    eq(a, 0);
    eq(b, 1);
  });
  it("핸들러 속성이 제거되면 리스너도 제거", () => {
    let n = 0;
    const fn = () => n++;
    const root = render(wrap(btn({ onclick: fn })));
    patch(root, diff(wrap(btn({ onclick: fn })), wrap(btn({}))));
    click(root.firstChild);
    eq(n, 0);
  });
  it("함수 핸들러가 문자열로 바뀌면 리스너 제거, 문자열은 속성으로 남지 않는다", () => {
    let n = 0;
    const fn = () => n++;
    const root = render(wrap(btn({ onclick: fn })));
    patch(root, diff(wrap(btn({ onclick: fn })), wrap(btn({ onclick: "window.__x=1" }))));
    click(root.firstChild);
    eq(n, 0);
    assert(!root.firstChild.hasAttribute("onclick"));
  });
  it("문자열 on* 속성은 실행되지 않는다", () => {
    window.__x = 0;
    const root = render(wrap(btn({ onclick: "window.__x=1" })));
    click(root.firstChild);
    eq(window.__x, 0);
  });

  it("isUnsafeAttr: 차단 대상", () => {
    for (const [n, v] of [
      ["href", "javascript:alert(1)"],
      ["href", "  JaVa\tScRiPt:alert(1)"],
      ["src", "vbscript:x"],
      ["action", "javascript:1"],
      ["formaction", "javascript:1"],
      ["xlink:href", "javascript:1"],
      ["data", "data:text/html,<b>"],
      ["srcdoc", "<p>"],
    ]) assert(isUnsafeAttr(n, v), `${n}=${v}`);
  });
  it("isUnsafeAttr: 안전한 값은 통과", () => {
    for (const [n, v] of [["href", "https://a.com/javascript:x"], ["href", "#top"], ["src", "data:image/png;base64,AA"], ["title", "javascript:1"]]) {
      assert(!isUnsafeAttr(n, v), `${n}=${v}`);
    }
  });
  it("차단 속성은 렌더링 시 DOM에 반영되지 않는다", () => {
    const dom = mk("");
    patch(dom, diff(htmlToVdom(""), htmlToVdom(`<a href="javascript:1">a</a><iframe srcdoc="<p>x</p>"></iframe><form action="javascript:1"></form><a href="/ok">b</a>`)));
    assert(!dom.querySelector("a").hasAttribute("href"));
    assert(!dom.querySelector("iframe").hasAttribute("srcdoc"));
    assert(!dom.querySelector("form").hasAttribute("action"));
    eq(dom.querySelectorAll("a")[1].getAttribute("href"), "/ok");
  });
  it("안전한 값이 차단 값으로 바뀌면 이전 값도 남지 않는다", () => {
    const dom = mk(`<a href="/ok">a</a>`);
    patch(dom, diff(containerToVdom(dom), htmlToVdom(`<a href="javascript:1">a</a>`)));
    assert(!dom.firstChild.hasAttribute("href"));
  });
  it("SVG xlink:href: 차단 값은 막고, 안전한 값은 xlink 네임스페이스로 반영", () => {
    const XLINK = "http://www.w3.org/1999/xlink";
    const dom = mk("");
    patch(dom, diff(htmlToVdom(""), htmlToVdom(`<svg><use id="ok" xlink:href="#a"></use><use id="bad" xlink:href="javascript:1"></use><a id="h" href="javascript:1"></a></svg>`)));
    eq(dom.querySelector("#ok").getAttributeNS(XLINK, "href"), "#a");
    assert(!dom.querySelector("#bad").hasAttributeNS(XLINK, "href"));
    assert(!dom.querySelector("#bad").hasAttribute("xlink:href"));
    assert(!dom.querySelector("#h").hasAttribute("href"));
  });
  it("SVG 요소는 SVG 네임스페이스로 만들어진다", () => {
    const dom = mk("");
    patch(dom, diff(htmlToVdom(""), htmlToVdom(`<svg><circle r="1"></circle></svg>`)));
    eq(dom.querySelector("circle").namespaceURI, "http://www.w3.org/2000/svg");
  });
});
