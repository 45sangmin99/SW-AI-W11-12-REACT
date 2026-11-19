import { describe, it, assert, eq, deepEq, throws, isDeepFrozen } from "./runner.js";
import { h, FunctionComponent, useState, useEffect, useMemo } from "../src/mini-react.js";

/** 컴포넌트를 새 컨테이너에 mount하고 { c, box }를 돌려준다 */
function mount(fn, props) {
  const box = document.createElement("div");
  const c = new FunctionComponent(fn, props);
  c.mount(box);
  return { c, box };
}

describe("FunctionComponent / useState", () => {
  it("mount: 처음 렌더링하고 hooks 배열을 가진다", () => {
    const { c, box } = mount(() => {
      useState(0);
      return h("p", null, "hi");
    });
    eq(box.innerHTML, "<p>hi</p>");
    assert(Array.isArray(c.hooks));
    eq(c.hooks.length, 1);
  });

  it("setState하면 별도 호출 없이 자동으로 다시 그려진다", () => {
    let set;
    const { box } = mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      return h("p", null, n);
    });
    set(5);
    eq(box.innerHTML, "<p>5</p>");
  });

  it("함수가 매번 다시 실행되어도 상태가 유지된다", () => {
    let set, renders = 0;
    const { box } = mount(() => {
      renders++;
      const [n, setN] = useState(10);
      set = setN;
      return h("p", null, n);
    });
    set((x) => x + 1);
    set((x) => x + 1);
    eq(box.textContent, "12");
    eq(renders, 3);
  });

  it("같은 값으로 setState하면 다시 그리지 않는다", () => {
    let set, renders = 0;
    mount(() => {
      renders++;
      const [n, setN] = useState(1);
      set = setN;
      return h("p", null, n);
    });
    set(1);
    eq(renders, 1);
  });

  it("초기값 함수는 최초 한 번만 실행", () => {
    let calls = 0, set;
    mount(() => {
      const [n, setN] = useState(() => (calls++, 0));
      set = setN;
      return h("p", null, n);
    });
    set(1);
    set(2);
    eq(calls, 1);
  });

  it("여러 상태는 서로 독립적", () => {
    let setA, setB;
    const { box } = mount(() => {
      const [a, sa] = useState("a");
      const [b, sb] = useState("b");
      setA = sa; setB = sb;
      return h("p", null, a, b);
    });
    setA("A");
    eq(box.textContent, "Ab");
    setB("B");
    eq(box.textContent, "AB");
  });

  it("바뀐 부분만 갱신: 변경 없는 DOM 노드는 그대로 유지", () => {
    let set;
    const { box } = mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      return h("div", null, h("h1", null, "title"), h("span", null, n), h("input", { value: "x" }));
    });
    const [h1, span, input] = box.firstChild.children;
    set(1);
    eq(box.firstChild.children[0], h1);
    eq(box.firstChild.children[1], span);
    eq(box.firstChild.children[2], input);
    eq(span.textContent, "1");
  });

  it("이벤트 핸들러는 항상 최신 클로저로 한 번만 실행된다", () => {
    const log = [];
    const { box } = mount(() => {
      const [n, setN] = useState(0);
      return h("button", { onClick: () => { log.push(n); setN(n + 1); } }, n);
    });
    const btn = box.firstChild;
    btn.click(); btn.click(); btn.click();
    deepEq(log, [0, 1, 2]);
    eq(btn.textContent, "3");
  });

  it("렌더링 중 setState는 예외", () => {
    throws(() => mount(() => {
      const [, set] = useState(0);
      set(1);
      return h("p");
    }), /렌더링 중/);
  });

  it("mount 두 번 / mount 전 update는 예외", () => {
    const c = new FunctionComponent(() => h("p"));
    throws(() => c.update(), /mount/);
    c.mount(document.createElement("div"));
    throws(() => c.mount(document.createElement("div")), /이미/);
  });

  it("루트는 요소 하나를 반환해야 한다", () => {
    throws(() => mount(() => "text"), /하나의 요소/);
    throws(() => mount(() => null), /하나의 요소/);
    throws(() => mount(() => document.createElement("div")), /하나의 요소/);
  });

  it("루트 요소의 태그가 바뀌면 새 루트로 교체된다", () => {
    let set;
    const { c, box } = mount(() => {
      const [x, s] = useState(true);
      set = s;
      return x ? h("p", null, "a") : h("section", null, "b");
    });
    set(false);
    eq(box.innerHTML, "<section>b</section>");
    eq(c.rootEl, box.firstChild);
  });
});

describe("제약: Hook 사용 위치", () => {
  it("컴포넌트 렌더링 밖에서 Hook을 호출하면 예외", () => {
    throws(() => useState(0), /루트 컴포넌트/);
    throws(() => useEffect(() => {}), /루트 컴포넌트/);
    throws(() => useMemo(() => 1, []), /루트 컴포넌트/);
  });

  it("자식 컴포넌트에서 Hook을 호출하면 예외", () => {
    const Child = () => { useState(1); return h("i"); };
    throws(() => mount(() => h("div", null, h(Child))), /자식 컴포넌트/);
  });

  it("자식 컴포넌트는 props만 받아 순수하게 렌더링한다", () => {
    const Item = ({ text, children }) => h("li", null, text, children);
    const { box } = mount(() => h("ul", null, ["a", "b"].map((t) => h(Item, { text: t }, h("b", null, "!")))));
    eq(box.innerHTML, "<ul><li>a<b>!</b></li><li>b<b>!</b></li></ul>");
  });

  it("자식 컴포넌트 실행 후에도 루트의 Hook은 계속 사용 가능", () => {
    const Child = () => h("i");
    const { box } = mount(() => {
      const child = h(Child);
      const [n] = useState(7); // 자식 호출 뒤에 호출해도 허용
      return h("p", null, child, n);
    });
    eq(box.innerHTML, "<p><i></i>7</p>");
  });
});

describe("Hook 호출 개수·순서 규칙", () => {
  it("렌더링 사이에 Hook 개수가 줄면 예외", () => {
    let on = true;
    const { c } = mount(() => {
      if (on) useState(1);
      useState(2);
      return h("p");
    });
    on = false;
    throws(() => c.update(), /Hook 호출 개수/);
  });

  it("렌더링 사이에 Hook 개수가 늘면 예외", () => {
    let more = false;
    const { c } = mount(() => {
      useState(1);
      if (more) useState(2);
      return h("p");
    });
    more = true;
    throws(() => c.update(), /Hook 호출 개수/);
  });

  it("같은 자리에서 Hook 종류가 바뀌면 예외", () => {
    let asState = true;
    const { c } = mount(() => {
      if (asState) useState(1);
      else useMemo(() => 1, []);
      return h("p");
    });
    asState = false;
    throws(() => c.update(), /순서/);
  });

  // 렌더링 중 검사(앞쪽)의 존재 이유: 잘못된 Hook 호출이 Hook 저장소를 오염시키기 전에 중단한다.
  // 이 테스트는 그 검사를 지우면 실패한다 (hooks 배열에 슬롯이 하나 더 생긴다).
  it("Hook이 늘어난 렌더링이 거부돼도 Hook 저장소에는 슬롯이 늘지 않고 effect도 실행되지 않는다", () => {
    let more = false, set, ran = 0;
    const { c, box } = mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      if (more) useEffect(() => { ran++; });
      return h("p", null, n);
    });
    more = true;
    throws(() => c.update(), /Hook 호출 개수/);
    eq(c.hooks.length, 1);
    eq(ran, 0);
    more = false;
    set(5); // 다음 정상 렌더링은 올바르게 동작
    eq(box.textContent, "5");
    eq(c.hooks.length, 1);
    eq(ran, 0);
  });

  it("Hook이 줄어든 렌더링이 거부된 뒤에도 다음 정상 렌더링에서 상태가 유지된다", () => {
    let skip = false, setA, setB;
    const { c, box } = mount(() => {
      const [a, sa] = useState("a");
      setA = sa;
      let b = "-";
      if (!skip) { const [v, sb] = useState("b"); setB = sb; b = v; }
      return h("p", null, a, b);
    });
    setB("B");
    skip = true;
    throws(() => c.update(), /Hook 호출 개수/);
    skip = false;
    setA("A");
    eq(box.textContent, "AB");
  });

  it("예외가 난 뒤에도 Hook 문맥이 정리되어 다음 컴포넌트가 정상 동작", () => {
    throws(() => mount(() => { useState(0); throw new Error("boom"); }), /boom/);
    throws(() => useState(0), /루트 컴포넌트/);
    mount(() => { useState(0); return h("p"); });
  });
});

describe("useMemo", () => {
  const withMemo = (getDeps) => {
    let set, calls = 0;
    const { box } = mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      useMemo(() => { calls++; return n; }, getDeps(n));
      return h("p", null, n);
    });
    return { set: (v) => set(v), calls: () => calls, box };
  };

  it("계산 결과를 저장해 재사용한다 (값이 같은 deps)", () => {
    let calls = 0, set, value;
    mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      value = useMemo(() => { calls++; return { sq: n * n }; }, [Math.floor(n / 10)]);
      return h("p", null, n);
    });
    const first = value;
    set(1); set(2);
    eq(calls, 1);
    eq(value, first);
  });
  it("deps 생략: 매 렌더링마다 다시 계산", () => {
    const m = withMemo(() => undefined);
    m.set(1); m.set(2);
    eq(m.calls(), 3);
  });
  it("deps []: 최초 한 번만 계산 (생략과 구분)", () => {
    const m = withMemo(() => []);
    m.set(1); m.set(2);
    eq(m.calls(), 1);
  });
  it("deps [값]: 값이 바뀔 때만 다시 계산", () => {
    const m = withMemo((n) => [n >= 2 ? 2 : n]);
    m.set(1); m.set(2); m.set(3);
    eq(m.calls(), 3); // 최초(0), 1, 2 / 3은 dep(2) 동일
  });
  it("Object.is 비교: NaN은 같은 값, +0과 -0은 다른 값", () => {
    const nan = withMemo(() => [NaN]);
    nan.set(1); nan.set(2);
    eq(nan.calls(), 1);
    const zero = withMemo((n) => [n % 2 ? -0 : 0]);
    zero.set(1);
    eq(zero.calls(), 2);
  });
  it("렌더링마다 새로 만드는 객체·배열 deps는 매번 다시 계산 (얕은 Object.is 비교)", () => {
    const m = withMemo(() => [{ a: 1 }]);
    m.set(1); m.set(2);
    eq(m.calls(), 3);
  });
  it("deps 길이가 바뀌면 다시 계산", () => {
    const m = withMemo((n) => (n === 0 ? [1] : [1, 2]));
    m.set(1);
    eq(m.calls(), 2);
  });
});

describe("useEffect", () => {
  const log = [];
  const harness = (getDeps, name = "e") => {
    log.length = 0;
    let set;
    const { c, box } = mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      useEffect(() => {
        log.push(`${name}${n}`);
        return () => log.push(`c${n}`);
      }, getDeps(n));
      return h("p", null, n);
    });
    return { set: (v) => set(v), c, box };
  };

  it("렌더링 후(Patch 후)에 실행된다: 실행 시점에 DOM은 이미 갱신되어 있다", () => {
    const seen = [];
    let set;
    const box = document.createElement("div"); // effect가 mount 도중 실행되므로 컨테이너를 먼저 만든다
    new FunctionComponent(() => {
      const [n, setN] = useState(0);
      set = setN;
      useEffect(() => { seen.push(box.textContent); });
      return h("p", null, n);
    }).mount(box);
    set(1);
    deepEq(seen, ["0", "1"]);
  });
  it("deps 생략: 매 렌더링 후 실행, 다음 실행 전에 이전 cleanup 호출", () => {
    const t = harness(() => undefined);
    t.set(1); t.set(2);
    deepEq(log, ["e0", "c0", "e1", "c1", "e2"]);
  });
  it("deps []: 최초 한 번만 실행되고 재렌더링에서 cleanup도 호출되지 않는다", () => {
    const t = harness(() => []);
    t.set(1); t.set(2);
    deepEq(log, ["e0"]);
  });
  it("deps [값]: 값이 바뀔 때만 실행 (이전 cleanup 먼저)", () => {
    const t = harness((n) => [Math.min(n, 1)]);
    t.set(1); t.set(2); t.set(3);
    deepEq(log, ["e0", "c0", "e1"]);
  });
  it("cleanup을 반환하지 않는 effect도 정상", () => {
    let set, runs = 0;
    mount(() => {
      const [n, s] = useState(0);
      set = s;
      useEffect(() => { runs++; });
      return h("p", null, n);
    });
    set(1);
    eq(runs, 2);
  });
  it("effect 안의 setState는 다시 그리며, 조건이 끝나면 멈춘다", () => {
    let renders = 0;
    const { box } = mount(() => {
      renders++;
      const [n, set] = useState(0);
      useEffect(() => { if (n < 3) set(n + 1); }, [n]);
      return h("p", null, n);
    });
    eq(box.textContent, "3");
    eq(renders, 4);
  });
  it("여러 effect는 선언 순서대로 실행", () => {
    const order = [];
    mount(() => {
      useEffect(() => { order.push(1); });
      useEffect(() => { order.push(2); });
      return h("p");
    });
    deepEq(order, [1, 2]);
  });
});

describe("렌더링 중 에러: Hook 기록은 성공한 렌더에서만 확정", () => {
  /** st.dep으로 deps를 바꾸고, st.fail이면 Hook 호출 뒤에 에러를 던지는 컴포넌트 */
  function setup() {
    const st = { dep: 1, fail: false, memoCalls: 0, memo: null, log: [] };
    const { c, box } = mount(() => {
      const dep = st.dep; // effect·cleanup 클로저가 렌더 시점의 값을 쓰도록 캡처
      useEffect(() => {
        st.log.push("e" + dep);
        return () => st.log.push("c" + dep);
      }, [dep]);
      st.memo = useMemo(() => {
        st.memoCalls++;
        return { dep };
      }, [dep]);
      if (st.fail) throw new Error("render failed");
      return h("p", null, dep);
    });
    return { st, c, box };
  }

  it("실패한 렌더 뒤 같은 새 deps로 복구하면 effect가 실행되고 memo도 정상 렌더 기준이다", () => {
    const { st, c, box } = setup();
    deepEq(st.log, ["e1"]);
    const memo1 = st.memo;
    eq(st.memoCalls, 1);

    st.dep = 2; st.fail = true; // 다른 deps로 렌더하다 에러
    throws(() => c.update(), /render failed/);
    deepEq(st.log, ["e1"]); // 실패한 렌더 때문에 cleanup(c1)도, 새 effect(e2)도 실행되지 않는다
    eq(box.textContent, "1"); // 화면은 마지막 정상 상태
    const failedMemo = st.memo; // 실패한 렌더가 계산한 값

    st.fail = false; // 같은 새 deps로 복구
    c.update();
    deepEq(st.log, ["e1", "c1", "e2"]); // effect가 건너뛰어지지 않고, cleanup은 새 effect 직전에 실행된다
    eq(box.textContent, "2");
    eq(st.memo.dep, 2);
    assert(st.memo !== failedMemo, "실패한 렌더의 memo 값을 재사용하면 안 된다");
    assert(st.memo !== memo1);
    eq(st.memoCalls, 3);

    c.update(); // 이제 정상 렌더의 기록 기준: 같은 deps라 재실행·재계산 없음
    deepEq(st.log, ["e1", "c1", "e2"]);
    eq(st.memoCalls, 3);
  });

  it("실패한 렌더 뒤 원래 deps로 돌아오면 마지막 정상 렌더 기록 기준으로 아무것도 다시 실행하지 않는다", () => {
    const { st, c } = setup();
    const memo1 = st.memo;
    st.dep = 2; st.fail = true;
    throws(() => c.update());
    st.dep = 1; st.fail = false;
    c.update();
    deepEq(st.log, ["e1"]); // 확정된 deps는 여전히 [1]
    eq(st.memo, memo1); // 캐시된 정상 값 재사용
    eq(st.memoCalls, 2); // 실패한 렌더에서 한 번 계산된 것이 전부
  });

  it("컴포넌트가 잘못된 값을 반환해 거부된 렌더도 기록을 확정하지 않는다", () => {
    const log = [];
    let dep = 1, bad = false;
    const { c } = mount(() => {
      const d = dep;
      useEffect(() => { log.push("e" + d); }, [d]);
      return bad ? "텍스트" : h("p", null, d);
    });
    dep = 2; bad = true;
    throws(() => c.update(), /하나의 요소/);
    bad = false;
    c.update();
    deepEq(log, ["e1", "e2"]);
  });

  it("실패 후에도 useState 값은 유지되고 이후 setState가 정상 동작한다", () => {
    let fail = false, set;
    const { c, box } = mount(() => {
      const [n, setN] = useState(0);
      set = setN;
      if (fail) throw new Error("boom");
      return h("p", null, n);
    });
    set(1);
    fail = true;
    throws(() => c.update(), /boom/);
    fail = false;
    set(2);
    eq(box.textContent, "2");
  });

  it("첫 렌더링이 실패하면 Hook 저장소를 비워서 같은 컴포넌트를 다시 mount할 수 있다", () => {
    let fail = true, inits = 0;
    const c = new FunctionComponent(() => {
      const [n] = useState(() => ++inits);
      useMemo(() => 1, []);
      useEffect(() => {}, []);
      if (fail) throw new Error("first render failed");
      return h("p", null, n);
    });
    const box = document.createElement("div");
    throws(() => c.mount(box), /first render failed/);
    eq(c.hooks.length, 0);
    eq(c.mounted, false);
    fail = false;
    c.mount(box);
    eq(box.textContent, "2"); // 초기값을 처음부터 다시 계산
    eq(c.hooks.length, 3);
  });

  it("자식 컴포넌트가 던진 에러도 같은 방식으로 처리된다", () => {
    const log = [];
    let dep = 1, fail = false;
    const Child = () => { if (fail) throw new Error("child failed"); return h("i"); };
    const { c } = mount(() => {
      const d = dep;
      useEffect(() => { log.push("e" + d); }, [d]);
      return h("div", null, h(Child));
    });
    dep = 2; fail = true;
    throws(() => c.update(), /child failed/);
    fail = false;
    c.update();
    deepEq(log, ["e1", "e2"]);
    throws(() => useState(0), /루트 컴포넌트/); // Hook 문맥도 정리됨
  });
});

describe("h(): Virtual DOM 만들기", () => {
  it("className -> class, true -> 빈 속성, false/null/undefined 속성은 제외", () => {
    const v = h("input", { className: "a", disabled: true, hidden: false, title: null, id: undefined, n: 3 });
    deepEq(v.props, { class: "a", disabled: "", n: "3" });
  });
  it("자식: 문자열·숫자는 텍스트 노드, null/boolean은 제외, 중첩 배열은 평탄화", () => {
    const v = h("p", null, "a", 1, null, false, [h("b"), ["c"]]);
    deepEq(v.children.map((c) => c.type + ":" + (c.tag ?? c.value)), ["text:a", "text:1", "element:b", "text:c"]);
  });
  it("<script>는 만들지 않는다", () => {
    eq(h("script", null, "alert(1)"), null);
  });
  it("DOM 노드나 호출하지 않은 컴포넌트를 자식으로 넣으면 예외", () => {
    throws(() => h("div", null, document.createElement("p")), /자식은/);
    throws(() => h("div", null, () => h("p")), /자식은/);
    throws(() => h("div", null, { type: "element" }), /자식은/);
  });
  it("함수 props는 그대로 유지", () => {
    const fn = () => {};
    eq(h("button", { onClick: fn }).props.onClick, fn);
  });
  it("컴포넌트가 렌더링한 Virtual DOM은 얼려진다", () => {
    const { c } = mount(() => h("div", null, h("p", { id: "x" }, "t")));
    assert(isDeepFrozen(c.vdom));
  });
});
