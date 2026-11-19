import { describe, it, assert, eq, deepEq, mk, tick, isDeepFrozen, assertMirrors } from "./runner.js";
import { domToVdom, containerToVdom, htmlToVdom, cleanContainer, deepFreeze } from "../src/vdom.js";
import { render } from "../src/dom.js";

describe("DOM -> Virtual DOM", () => {
  it("텍스트 노드는 { type: text, value }", () => {
    deepEq(domToVdom(document.createTextNode("안녕")), { type: "text", value: "안녕" });
  });

  it("요소는 tag, props(속성), children을 가진다", () => {
    const el = mk(`<a href="/x" class="c" data-id="7">링크</a>`).firstChild;
    deepEq(domToVdom(el), {
      type: "element",
      tag: "a",
      props: { href: "/x", class: "c", "data-id": "7" },
      children: [{ type: "text", value: "링크" }],
    });
  });

  it("중첩 구조를 그대로 옮긴다", () => {
    const v = htmlToVdom("<ul><li>1</li><li><b>2</b></li></ul>");
    eq(v.children[0].children.length, 2);
    eq(v.children[0].children[1].children[0].tag, "b");
  });

  it("공백만 있는 텍스트 노드는 보존한다", () => {
    const v = htmlToVdom("<ul>\n  <li>a</li>\n</ul>");
    deepEq(v.children[0].children.map((c) => c.type), ["text", "element", "text"]);
    eq(v.children[0].children[0].value, "\n  ");
  });

  it("주석은 제외한다", () => {
    const v = htmlToVdom("<p>a</p><!-- 주석 --><p>b</p>");
    eq(v.children.length, 2);
  });

  it("<script>는 (중첩되어 있어도) 제외한다", () => {
    const v = htmlToVdom("<script>1</script><div><script>2</script><p>x</p></div>");
    eq(v.children.length, 1);
    eq(v.children[0].children.length, 1);
    eq(v.children[0].children[0].tag, "p");
  });

  it("제외 노드 때문에 맞붙은 텍스트는 하나로 병합한다", () => {
    const comment = htmlToVdom("a<!--c-->b");
    deepEq(comment.children, [{ type: "text", value: "ab" }]);
    const script = htmlToVdom("a<script>1</script>b<!--x-->c");
    deepEq(script.children, [{ type: "text", value: "abc" }]);
  });

  it("제외 노드가 없으면 맞붙은 텍스트 노드도 병합하지 않는다 (1:1 대응)", () => {
    const d = document.createElement("div");
    d.append("a", "b");
    eq(containerToVdom(d).children.length, 2);
  });

  it("요소 사이의 텍스트는 병합되지 않는다", () => {
    eq(htmlToVdom("a<b></b>c").children.length, 3);
  });

  it("containerToVdom: 루트는 컨테이너의 id·class와 무관하게 props가 빈 div", () => {
    const d = mk("<p>x</p>");
    d.id = "real-root";
    d.className = "content";
    const v = containerToVdom(d);
    eq(v.tag, "div");
    deepEq(v.props, {});
  });

  it("htmlToVdom은 이미지 onerror·스크립트를 실행하지 않는다", async () => {
    window.__pwned = 0;
    htmlToVdom(`<img src="x://bad" onerror="window.__pwned=1"><script>window.__pwned=2</script>`);
    await tick(50);
    eq(window.__pwned, 0);
  });
});

describe("cleanContainer (실제 DOM과 Virtual DOM 인덱스 정렬)", () => {
  it("주석과 <script>를 실제 DOM에서도 지운다", () => {
    const d = mk(`<p>a</p><!--c--><script>1</script><div><!--z--><script>2</script><i>x</i></div>`);
    cleanContainer(d);
    eq(d.innerHTML, "<p>a</p><div><i>x</i></div>");
  });

  it("맞붙은 텍스트 노드를 합치고 빈 텍스트 노드를 없앤다", () => {
    const d = mk(`a<!--c-->b`);
    d.appendChild(document.createTextNode(""));
    cleanContainer(d);
    eq(d.childNodes.length, 1);
    eq(d.firstChild.nodeValue, "ab");
  });

  it("정리 후에는 DOM 구조와 Virtual DOM이 노드 단위로 일치한다", () => {
    const d = mk(`<p>a</p><!--c-->x<script>1</script>y<ul>\n<!--m--><li>1</li></ul><b>end</b>`);
    cleanContainer(d);
    assertMirrors(d, containerToVdom(d));
  });

  it("정리하지 않으면 인덱스가 어긋난다 (정리가 필요한 이유)", () => {
    const d = mk(`<!--c--><p>a</p>`);
    eq(d.childNodes.length, 2);
    eq(containerToVdom(d).children.length, 1);
  });
});

describe("<template> (내용은 template.content에 있다)", () => {
  it("domToVdom: template.content의 내용을 children으로 옮긴다", () => {
    const t = mk("<template><p>x</p>text</template>").firstChild;
    eq(t.childNodes.length, 0); // 일반 childNodes는 비어 있다
    const v = domToVdom(t);
    deepEq(v.children.map((c) => c.type + ":" + (c.tag ?? c.value)), ["element:p", "text:text"]);
  });
  it("htmlToVdom: 중첩된 template과 그 안의 주석·스크립트 제외", () => {
    const v = htmlToVdom("<template><p>a</p><!--c--><script>1</script><template><i>n</i></template></template>");
    const outer = v.children[0];
    eq(outer.tag, "template");
    deepEq(outer.children.map((c) => c.tag), ["p", "template"]);
    eq(outer.children[1].children[0].tag, "i");
  });
  it("render: 자식은 template.content에 붙고 childNodes는 비어 있다", () => {
    const el = render(htmlToVdom("<template><p>x</p></template>").children[0]);
    eq(el.childNodes.length, 0);
    eq(el.content.childNodes.length, 1);
    eq(el.content.firstChild.localName, "p");
  });
  it("cleanContainer: template.content 안의 주석·스크립트도 지운다", () => {
    const d = mk("<template><!--c--><p>a</p><script>1</script>x<!--m-->y</template>");
    cleanContainer(d);
    eq(d.firstChild.innerHTML, "<p>a</p>xy");
    assertMirrors(d, containerToVdom(d));
  });
  it("innerHTML 왕복: 직렬화한 HTML을 다시 변환해도 같은 Virtual DOM", () => {
    const d = mk("<template><p class='a'>x</p></template>");
    deepEq(htmlToVdom(d.innerHTML), containerToVdom(d));
  });
});

describe("deepFreeze (히스토리 스냅샷 보호)", () => {
  it("자식·props·children 배열까지 깊게 얼린다", () => {
    const v = deepFreeze(htmlToVdom(`<ul class="a"><li>1</li><li>2</li></ul>`));
    assert(isDeepFrozen(v));
  });

  it("얼린 뒤 수정하면 예외가 난다", () => {
    const v = deepFreeze(htmlToVdom(`<p class="a">x</p>`));
    const p = v.children[0];
    assert(throwsSafe(() => (p.children[0].value = "H")));
    assert(throwsSafe(() => (p.props.class = "H")));
    assert(throwsSafe(() => v.children.push({})));
    assert(throwsSafe(() => (p.tag = "div")));
  });

  it("Virtual DOM이 일반 객체·배열·문자열만 담는지 (DOM 노드 참조 없음)", () => {
    const seen = [];
    (function walk(x) {
      seen.push(x);
      if (x.children) x.children.forEach(walk);
    })(htmlToVdom(`<div id="a">t<span>u</span></div>`));
    assert(seen.every((n) => Object.getPrototypeOf(n) === Object.prototype));
    assert(seen.every((n) => !(n instanceof Node)));
    assert(seen.filter((n) => n.props).every((n) => Object.values(n.props).every((v) => typeof v === "string")));
  });
});

function throwsSafe(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
