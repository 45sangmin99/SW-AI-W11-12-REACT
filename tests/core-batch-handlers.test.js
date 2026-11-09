// 코어 확장 검증: 이벤트 핸들러 안정화(REBIND)와 Batching (O-01)
import { describe, it, assert, eq, deepEq, throws } from "./runner.js";
import { diff, REBIND, UPDATE_PROPS, countDomChanges } from "../src/diff.js";
import { patch } from "../src/patch.js";
import { render } from "../src/dom.js";
import { h, FunctionComponent, useState, batch } from "../src/mini-react.js";

const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const btn = (props) => ({ type: "element", tag: "button", props, children: [] });
const wrap = (child) => ({ type: "element", tag: "div", props: {}, children: [child] });

function mount(fn, props) {
  const box = document.createElement("div");
  const c = new FunctionComponent(fn, props);
  c.mount(box);
  return { c, box };
}

describe("Diff: 핸들러 참조 교체(REBIND)", () => {
  it("같은 함수면 변경 없음", () => {
    const fn = () => {};
    deepEq(diff(wrap(btn({ onclick: fn })), wrap(btn({ onclick: fn }))), []);
  });

  it("함수가 새 함수로 바뀌면 UPDATE_PROPS가 아니라 REBIND 하나만 나온다", () => {
    const changes = diff(wrap(btn({ onclick: () => 1 })), wrap(btn({ onclick: () => 2 })));
    eq(changes.length, 1);
    eq(changes[0].type, REBIND);
    deepEq(changes[0].path, [0]);
    eq(countDomChanges(changes), 0, "REBIND는 DOM 변경 수에 세지 않는다");
  });

  it("함수 → 문자열, 문자열 → 함수는 속성 변경(UPDATE_PROPS)으로 처리", () => {
    const fn = () => {};
    const a = diff(wrap(btn({ onclick: fn })), wrap(btn({ onclick: "x" })));
    eq(a[0].type, UPDATE_PROPS);
    const b = diff(wrap(btn({ onclick: "x" })), wrap(btn({ onclick: fn })));
    eq(b[0].type, UPDATE_PROPS);
  });

  it("글자와 REBIND가 같이 있으면 DOM 변경 수에는 글자 변경만 센다", () => {
    const mk = (label, fn) => ({ type: "element", tag: "button", props: { onclick: fn }, children: [{ type: "text", value: label }] });
    const changes = diff(wrap(mk("a", () => 1)), wrap(mk("b", () => 2)));
    eq(changes.length, 2);
    eq(countDomChanges(changes), 1);
  });
});

describe("Patch: REBIND는 리스너를 다시 붙이지 않고 최신 핸들러만 바꾼다", () => {
  it("addEventListener를 다시 부르지 않고, 클릭하면 최신 핸들러가 한 번만 실행", () => {
    let a = 0, b = 0;
    const root = render(wrap(btn({ onclick: () => a++ })));
    const el = root.firstChild;
    let adds = 0;
    const orig = el.addEventListener.bind(el);
    el.addEventListener = (...args) => { adds++; return orig(...args); };

    patch(root, diff(wrap(btn({ onclick: () => a++ })), wrap(btn({ onclick: () => b++ }))));
    eq(adds, 0, "리스너를 새로 붙이지 않는다");
    eq(root.firstChild, el, "같은 DOM 노드 유지");
    click(el);
    eq(a, 0);
    eq(b, 1);
  });

  it("여러 번 교체해도 항상 마지막 핸들러만 한 번 실행 (중복 실행 없음)", () => {
    const calls = [];
    const root = render(wrap(btn({ onclick: () => calls.push(0) })));
    let prev = wrap(btn({ onclick: () => calls.push(0) }));
    for (let i = 1; i <= 5; i++) {
      const next = wrap(btn({ onclick: () => calls.push(i) }));
      patch(root, diff(prev, next));
      prev = next;
    }
    click(root.firstChild);
    deepEq(calls, [5]);
  });

  it("핸들러가 제거되면 리스너도 제거되고, 다시 붙이면 새로 동작", () => {
    let n = 0;
    const root = render(wrap(btn({ onclick: () => n++ })));
    patch(root, diff(wrap(btn({ onclick: () => n++ })), wrap(btn({}))));
    click(root.firstChild);
    eq(n, 0);
    patch(root, diff(wrap(btn({})), wrap(btn({ onclick: () => (n += 10) }))));
    click(root.firstChild);
    eq(n, 10);
  });

  it("핸들러 안에서 this는 요소다", () => {
    let seen;
    const root = render(wrap(btn({ onclick: function () { seen = this; } })));
    click(root.firstChild);
    eq(seen, root.firstChild);
  });
});

describe("FunctionComponent: 핸들러가 항상 최신 상태를 본다 (stale closure 방지)", () => {
  it("렌더링마다 새 핸들러가 붙어도 클릭은 최신 상태 기준으로 동작", () => {
    const { c, box } = mount(() => {
      const [n, setN] = useState(0);
      return h("button", { onClick: () => setN(n + 1) }, "n=", n);
    });
    const el = box.firstChild;
    click(el);
    click(el);
    click(el);
    eq(el.textContent, "n=3");
    eq(box.firstChild, el, "버튼 DOM 노드는 그대로");
    eq(c.lastChanges.filter((x) => x.type === REBIND).length, 1);
    eq(countDomChanges(c.lastChanges), 1, "실제 DOM 변경은 글자 하나");
  });

  it("값이 안 바뀐 형제는 DOM 변경 목록에 나오지 않는다", () => {
    let set;
    const { c, box } = mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      return h("div", null,
        h("p", null, "고정"),
        h("button", { onClick: () => {} }, "버튼"),
        h("span", null, n));
    });
    const p = box.querySelector("p");
    set(1);
    eq(box.querySelector("p"), p);
    eq(countDomChanges(c.lastChanges), 1);
    deepEq(c.lastChanges.find((x) => x.type === "UPDATE_TEXT").path, [2, 0]);
  });
});

describe("Batching (O-01)", () => {
  it("batch 밖의 setState는 예전처럼 즉시 다시 그린다", () => {
    let set, renders = 0;
    const { box } = mount(() => {
      renders++;
      const [n, setN] = useState(0);
      set = setN;
      return h("p", null, n);
    });
    set(1);
    eq(box.textContent, "1");
    eq(renders, 2);
  });

  it("batch 안의 여러 setState는 렌더링 한 번으로 합쳐진다", () => {
    let a, b, renders = 0;
    const { box } = mount(() => {
      renders++;
      const [x, setX] = useState(0);
      const [y, setY] = useState(0);
      a = setX; b = setY;
      return h("p", null, x, "/", y);
    });
    batch(() => {
      a(1);
      b(2);
      eq(box.textContent, "0/0", "batch가 끝나기 전에는 화면이 그대로");
    });
    eq(box.textContent, "1/2");
    eq(renders, 2, "처음 + batch 한 번");
  });

  it("함수형 업데이터는 batch 안에서도 누적된다", () => {
    let set, renders = 0;
    const { box } = mount(() => {
      renders++;
      const [n, setN] = useState(0);
      set = setN;
      return h("p", null, n);
    });
    batch(() => {
      set((v) => v + 1);
      set((v) => v + 1);
      set((v) => v + 1);
    });
    eq(box.textContent, "3");
    eq(renders, 2);
  });

  it("batch를 중첩하면 가장 바깥이 끝날 때 한 번만 그린다", () => {
    let set, renders = 0;
    mount(() => {
      renders++;
      const [n, setN] = useState(0);
      set = setN;
      return h("p", null, n);
    });
    batch(() => {
      set(1);
      batch(() => set(2));
      eq(renders, 1, "안쪽 batch가 끝나도 아직 그리지 않는다");
    });
    eq(renders, 2);
  });

  it("값이 그대로면 batch 안에서도 다시 그리지 않는다", () => {
    let set, renders = 0;
    mount(() => {
      renders++;
      const [n, setN] = useState(5);
      set = setN;
      return h("p", null, n);
    });
    batch(() => set(5));
    eq(renders, 1);
  });

  it("batch는 콜백의 반환값을 돌려준다", () => {
    eq(batch(() => 42), 42);
  });

  it("콜백에서 예외가 나도 이미 바꾼 상태는 화면에 반영하고 예외는 그대로 던진다", () => {
    let set;
    const { box } = mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      return h("p", null, n);
    });
    throws(() => batch(() => { set(7); throw new Error("boom"); }), /boom/);
    eq(box.textContent, "7");
  });

  it("컴포넌트가 둘이면 각각 한 번씩 그린다", () => {
    const r = { a: 0, b: 0 };
    let setA, setB;
    const A = mount(() => { r.a++; const [n, s] = useState(0); setA = s; return h("p", null, n); });
    const B = mount(() => { r.b++; const [n, s] = useState(0); setB = s; return h("p", null, n); });
    batch(() => { setA(1); setA(2); setB(1); });
    eq(A.box.textContent, "2");
    eq(B.box.textContent, "1");
    eq(r.a, 2);
    eq(r.b, 2);
  });

  it("한 컴포넌트의 렌더 에러가 다른 컴포넌트의 갱신을 막지 않는다", () => {
    let setA, setB;
    mount(() => {
      const [n, s] = useState(0);
      setA = s;
      if (n === 99) throw new Error("render fail");
      return h("p", null, n);
    });
    const B = mount(() => { const [n, s] = useState(0); setB = s; return h("p", null, n); });
    throws(() => batch(() => { setA(99); setB(5); }), /render fail/);
    eq(B.box.textContent, "5");
  });

  it("이벤트 핸들러 안의 여러 setState는 자동으로 렌더링 한 번", () => {
    let renders = 0;
    const { box } = mount(() => {
      renders++;
      const [a, setA] = useState(0);
      const [b, setB] = useState(0);
      return h("button", { onClick: () => { setA(a + 1); setB(b + 10); } }, a, "/", b);
    });
    click(box.firstChild);
    eq(box.firstChild.textContent, "1/10");
    eq(renders, 2, "처음 + 클릭 한 번 (setState가 둘이어도)");
  });

  it("필터를 바꾸면서 페이지를 1로 되돌려도 '새 필터 + 옛 페이지' 중간 상태는 그려지지 않는다", () => {
    const seen = [];
    const { box } = mount(() => {
      const [filter, setFilter] = useState("a");
      const [page, setPage] = useState(3);
      seen.push(`${filter}:${page}`);
      return h("button", { onClick: () => { setFilter("b"); setPage(1); } }, filter, page);
    });
    click(box.firstChild);
    deepEq(seen, ["a:3", "b:1"]);
  });
});
