import assert from "node:assert/strict";
import { test } from "node:test";
import { FunctionComponent, useEffect, useMemo, useState } from "../src/component.js";
import { LogisticsSimulator } from "../src/logistics.js";

function withNodeMethods(node) {
  node.remove = function remove() {
    this.parentNode?.removeChild(this);
  };
  node.replaceWith = function replaceWith(replacement) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    parent.insertBefore(replacement, this);
    parent.removeChild(this);
  };
  return node;
}

function createDocument() {
  return {
    createElement(tagName) {
      return withNodeMethods({
        nodeType: 1,
        tagName,
        attributes: {},
        childNodes: [],
        parentNode: null,
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
        getAttribute(name) {
          return this.attributes[name] ?? null;
        },
        removeAttribute(name) {
          delete this.attributes[name];
        },
        appendChild(child) {
          return this.insertBefore(child, null);
        },
        insertBefore(child, reference) {
          child.remove();
          const index = reference === null
            ? this.childNodes.length
            : this.childNodes.indexOf(reference);
          this.childNodes.splice(index, 0, child);
          child.parentNode = this;
          return child;
        },
        removeChild(child) {
          const index = this.childNodes.indexOf(child);
          this.childNodes.splice(index, 1);
          child.parentNode = null;
          return child;
        },
        replaceChildren(...children) {
          this.childNodes.forEach((child) => {
            child.parentNode = null;
          });
          this.childNodes = [];
          children.forEach((child) => this.appendChild(child));
        },
      });
    },
    createTextNode(nodeValue) {
      return withNodeMethods({ nodeType: 3, nodeValue, parentNode: null });
    },
  };
}

function view({ message }) {
  return {
    type: "section",
    props: { class: "view" },
    children: [
      { type: "h2", props: {}, children: ["Title"] },
      { type: "p", props: {}, children: [message] },
    ],
  };
}

function readMovementLog(log) {
  const entries = log.childNodes[1];
  return entries.tagName === "ol"
    ? entries.childNodes.map((entry) => entry.childNodes[0].nodeValue)
    : [];
}

function readSummary(summary) {
  return summary.childNodes[1].childNodes.map((metric) => metric.childNodes[1].childNodes[0].nodeValue);
}

function mountLogistics() {
  const documentRef = createDocument();
  const container = documentRef.createElement("div");
  const component = new FunctionComponent(LogisticsSimulator, {}, container, documentRef);
  const root = component.mount();
  const [, map, controls, status, details] = root.childNodes;
  const [summary, log, dispatch] = details.childNodes;
  const [steps, auto] = controls.childNodes;
  const [previous, manual] = steps.childNodes;
  return { component, container, root, map, status, summary, log, dispatch, manual, auto, previous };
}

function markerCoordinate(marker, axis) {
  return Number(marker.getAttribute("style").match(new RegExp(`${axis}:([\\d.]+)%`))[1]);
}

test("세 차량이 각 속도로 이동하고 분류 허브를 넘어 남은 거리만큼 이동한다", () => {
  const { component, container, root, map, status, summary, log, dispatch, manual, auto } = mountLogistics();
  const [hubs, ...mapParts] = map.childNodes;
  const markers = mapParts.filter((node) => node.getAttribute("data-vehicle"));
  const originalHubs = [...hubs.childNodes];
  const originWaiting = () => originalHubs[0].childNodes[1].childNodes[0].nodeValue;
  assert.equal(originalHubs.length, 5);
  assert.deepEqual(markers.map((marker) => marker.childNodes.map((part) => part.childNodes[0].nodeValue)),
    [["T-01 · 3건", "🚚"], ["T-02 · 2건", "🚚"], ["T-03 · 4건", "🚚"]]);
  assert.deepEqual(readSummary(summary), ["9건", "0건", "0건", "0%"]);
  assert.equal(originWaiting(), "대기 9건");
  assert.deepEqual(dispatch.childNodes[2].childNodes.map((row) => {
    const [title, load, route] = row.childNodes[0].childNodes;
    return title.childNodes[0].childNodes[0].nodeValue + " · " + load.childNodes[0].nodeValue
      + " | " + route.childNodes[0].nodeValue;
  }), [
    "T-01 · 화물 3건 · 60km/h | 출발 허브 → 분류 허브 → 동부 배송지 · 5.2km",
    "T-02 · 화물 2건 · 45km/h | 출발 허브 → 분류 허브 → 서부 배송지 · 6.2km",
    "T-03 · 화물 4건 · 36km/h | 출발 허브 → 분류 허브 → 남부 배송지 · 7.2km",
  ]);
  assert.deepEqual(readMovementLog(log), []);

  manual.onclick();
  assert.equal(originWaiting(), "대기 0건");
  assert.deepEqual(readSummary(summary), ["0건", "9건", "0건", "0%"]);
  assert.deepEqual(markers.map((marker) => markerCoordinate(marker, "left")),
    [25.9375, 23.203125, 21.5625]);
  assert.equal(container.childNodes[0], root);
  assert.equal(component.root.childNodes[1], map);
  originalHubs.forEach((hub, index) => assert.equal(hubs.childNodes[index], hub));
  markers.forEach((marker, index) => assert.equal(map.childNodes[index + 5], marker));
  assert.deepEqual(component.lastPatches.filter(({ path }) => path[0] === 1)
    .map(({ type, path }) => [type, path]), [
    ["UPDATE_TEXT", [1, 0, 0, 1, 0]],
    ["UPDATE_PROPS", [1, 5]], ["UPDATE_PROPS", [1, 6]], ["UPDATE_PROPS", [1, 7]],
  ]);

  for (let minute = 2; minute <= 4; minute++) manual.onclick();
  // T-01 uses 0.2 km to reach the hub in minute 4, then travels 0.8 km of its 2 km branch.
  assert.equal(markerCoordinate(markers[0], "left"), 64);
  assert.equal(markerCoordinate(markers[0], "top"), 38.4);
  assert.deepEqual(readMovementLog(log), ["T-01 · 출발 허브 → 분류 허브"]);

  manual.onclick();
  assert.ok(Math.abs(markerCoordinate(markers[1], "left") - 56.4166666667) < 0.00001);
  const southMarker = markers[2];
  const laneOffset = () => Number(southMarker.getAttribute("style").match(/--lane:([\d.]+)px/)[1]);
  assert.equal(laneOffset(), 54);
  const manualAdvance = manual.onclick;
  manualAdvance();
  assert.deepEqual(readSummary(summary), ["0건", "6건", "3건", "33%"]);
  assert.equal(markerCoordinate(markers[0], "left"), 85);
  assert.equal(manual.getAttribute("disabled"), null);

  assert.ok(markerCoordinate(southMarker, "top") > 50);
  assert.ok(laneOffset() > 48 && laneOffset() < 54);

  for (let minute = 7; minute <= 12; minute++) manualAdvance();
  assert.deepEqual(readSummary(summary), ["0건", "0건", "9건", "100%"]);
  assert.deepEqual(markers.map((marker) => markerCoordinate(marker, "top")), [21, 50, 79]);
  assert.match(status.childNodes[0].nodeValue, /모든 차량이 도착했습니다.*12분/);
  assert.equal(manual.getAttribute("disabled"), "");
  assert.equal(auto.getAttribute("disabled"), "");
  assert.deepEqual(readMovementLog(log), [
    "T-01 · 출발 허브 → 분류 허브",
    "T-02 · 출발 허브 → 분류 허브",
    "T-01 · 분류 허브 → 동부 배송지",
    "T-03 · 출발 허브 → 분류 허브",
    "T-02 · 분류 허브 → 서부 배송지",
    "T-03 · 분류 허브 → 남부 배송지",
  ]);
  manualAdvance();
  assert.equal(readMovementLog(log).length, 6);
  assert.match(status.childNodes[0].nodeValue, /12분/);
});

test("배차 목록은 차량별 도착 예상 시각과 완료 상태를 표시하고 되돌리면 복원한다", () => {
  const { dispatch, manual, previous } = mountLogistics();
  const readStatuses = () => dispatch.childNodes[2].childNodes
    .map((row) => row.childNodes[0].childNodes[0].childNodes[2].childNodes[0].nodeValue);

  assert.deepEqual(readStatuses().map((status) => status.match(/도착 예상: 경과 (\d+)분/)[1]), ["6", "9", "12"]);
  for (let minute = 1; minute <= 11; minute++) manual.onclick();
  const beforeArrival = readStatuses();
  assert.equal(beforeArrival[2], "도착 예상: 경과 12분");
  manual.onclick();
  assert.equal(readStatuses()[2], "배송 완료");
  previous.onclick();
  assert.deepEqual(readStatuses(), beforeArrival);
});

test("도착 순서를 바꿔도 펼친 차량 상세를 그대로 옮긴다", () => {
  const { component, dispatch } = mountLogistics();
  const [, label, list] = dispatch.childNodes;
  const select = label.childNodes[1];
  const [first, second, row] = list.childNodes;
  const [details] = row.childNodes;
  details.setAttribute("open", "");

  select.onchange({ target: { value: "slowest" } });
  assert.deepEqual(list.childNodes.map((item) => item.getAttribute("key")), ["T-03", "T-02", "T-01"]);
  assert.equal(list.childNodes[0], row);
  assert.equal(list.childNodes[1], second);
  assert.equal(list.childNodes[2], first);
  assert.equal(row.childNodes[0], details);
  assert.equal(details.getAttribute("open"), "");
  const structuralPatches = component.lastPatches.filter(({ type }) => type !== "UPDATE_PROPS");
  assert.deepEqual(structuralPatches, [
    { type: "MOVE", path: [4, 2, 2], key: "T-03", to: 0 },
    { type: "MOVE", path: [4, 2, 2], key: "T-02", to: 1 },
  ]);

  select.onchange({ target: { value: "fastest" } });
  assert.equal(list.childNodes[2], row);
  assert.equal(details.getAttribute("open"), "");
});

test("한 단계 이전은 차량 위치, 배송 현황, 이동 기록을 함께 되돌린다", () => {
  const { map, status, summary, log, manual, auto, previous } = mountLogistics();
  const markers = map.childNodes.filter((node) => node.getAttribute("data-vehicle"));
  assert.equal(previous.getAttribute("disabled"), "");

  for (let minute = 1; minute <= 11; minute++) manual.onclick();
  const positionsBeforeArrival = markers.map((marker) => marker.getAttribute("style"));
  const logBeforeArrival = readMovementLog(log);
  assert.equal(logBeforeArrival.length, 5);
  manual.onclick();
  assert.deepEqual(readSummary(summary), ["0건", "0건", "9건", "100%"]);
  assert.equal(previous.getAttribute("disabled"), null);

  previous.onclick();
  assert.match(status.childNodes[0].nodeValue, /11분/);
  assert.deepEqual(markers.map((marker) => marker.getAttribute("style")), positionsBeforeArrival);
  assert.deepEqual(readMovementLog(log), logBeforeArrival);
  assert.deepEqual(readSummary(summary), ["0건", "4건", "5건", "56%"]);
  assert.equal(manual.getAttribute("disabled"), null);
  assert.equal(auto.getAttribute("disabled"), null);
  manual.onclick();
  assert.equal(readMovementLog(log).length, 6);

  for (let minute = 12; minute > 0; minute--) previous.onclick();
  assert.equal(status.childNodes[0].nodeValue, "출발 대기 · 경과 0분");
  assert.deepEqual(readSummary(summary), ["9건", "0건", "0건", "0%"]);
  assert.deepEqual(readMovementLog(log), []);
  assert.equal(previous.getAttribute("disabled"), "");
});

test("자동 진행은 수동과 같은 한 틱을 실행하고 정지·도착·해제 시 타이머를 정리한다", (t) => {
  const callbacks = new Map();
  let nextTimer = 0;
  t.mock.method(globalThis, "setInterval", (callback, delay) => {
    assert.equal(delay, 1000);
    callbacks.set(++nextTimer, callback);
    return nextTimer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => callbacks.delete(timer));
  const tick = () => [...callbacks.values()].forEach((callback) => callback());

  const { component, map, status, summary, log, manual, auto, previous } = mountLogistics();
  const [hubList] = map.childNodes;
  const originalHubs = [...hubList.childNodes];
  const readMemo = () => component.hooks.find((hook) => hook.type === "memo").value;
  const initialSummary = readMemo();
  const start = auto.onclick;
  start();
  start();
  assert.equal(nextTimer, 1);
  assert.equal(callbacks.size, 1);
  assert.equal(manual.getAttribute("disabled"), "");
  assert.equal(readMemo(), initialSummary);

  tick();
  assert.match(status.childNodes[0].nodeValue, /자동 진행 중.*1분/);
  assert.equal(previous.getAttribute("disabled"), "");
  assert.deepEqual(readSummary(summary), ["0건", "9건", "0건", "0%"]);
  originalHubs.forEach((hub, index) => assert.equal(hubList.childNodes[index], hub));
  assert.equal(markerCoordinate(map.childNodes[5], "left"), 25.9375);
  assert.deepEqual(component.lastPatches.filter(({ path }) => path[0] === 1)
    .map(({ type, path }) => [type, path]), [
    ["UPDATE_TEXT", [1, 0, 0, 1, 0]],
    ["UPDATE_PROPS", [1, 5]], ["UPDATE_PROPS", [1, 6]], ["UPDATE_PROPS", [1, 7]],
  ]);
  const movingSummary = readMemo();
  auto.onclick();
  assert.equal(callbacks.size, 0);
  assert.equal(manual.getAttribute("disabled"), null);
  assert.equal(previous.getAttribute("disabled"), null);
  tick();
  assert.equal(status.childNodes[0].nodeValue, "일시 정지 · 경과 1분");
  assert.equal(readMemo(), movingSummary);
  assert.deepEqual(readMovementLog(log), []);

  auto.onclick();
  for (let minute = 2; minute <= 12; minute++) tick();
  assert.equal(callbacks.size, 0);
  assert.equal(auto.getAttribute("disabled"), "");
  assert.equal(manual.getAttribute("disabled"), "");
  assert.deepEqual(readSummary(summary), ["0건", "0건", "9건", "100%"]);
  assert.equal(readMovementLog(log).length, 6);

  component.unmount();
  const [, , nextControls] = component.mount().childNodes;
  nextControls.childNodes[1].onclick();
  assert.equal(callbacks.size, 1);
  component.unmount();
  assert.equal(callbacks.size, 0);
});

test("mount()가 함수형 컴포넌트를 실행해 최초 DOM을 만든다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  const component = new FunctionComponent(
    view,
    { message: "Hello" },
    container,
    documentRef,
  );

  const root = component.mount();

  assert.equal(container.childNodes[0], root);
  assert.equal(root.childNodes[1].childNodes[0].nodeValue, "Hello");
  assert.deepEqual(component.hooks, []);
  assert.equal(component.hookIndex, 0);
  assert.equal(component.mounted, true);
});

test("update()가 props로 다시 실행하고 기존 DOM을 Diff·Patch한다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  const component = new FunctionComponent(
    view,
    { message: "Old" },
    container,
    documentRef,
  );
  component.mount();
  const heading = component.root.childNodes[0];
  component.hookIndex = 7;

  const patches = component.update({ message: "New" });

  assert.deepEqual(patches, [
    { type: "UPDATE_TEXT", path: [1, 0], value: "New" },
  ]);
  assert.equal(component.root.childNodes[0], heading);
  assert.equal(component.root.childNodes[1].childNodes[0].nodeValue, "New");
  assert.deepEqual(component.props, { message: "New" });
  assert.equal(component.hookIndex, 0);
});

test("컴포넌트가 null과 요소 사이를 업데이트할 수 있다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  const component = new FunctionComponent(
    ({ visible }) => visible ? view({ message: "Visible" }) : null,
    { visible: false },
    container,
    documentRef,
  );

  assert.equal(component.mount(), null);
  assert.equal(container.childNodes.length, 0);
  component.update({ visible: true });
  assert.equal(container.childNodes.length, 1);
  component.update({ visible: false });
  assert.equal(container.childNodes.length, 0);
});

test("mount와 update의 잘못된 호출 순서를 거부한다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  const component = new FunctionComponent(view, { message: "Hello" }, container, documentRef);

  assert.throws(() => component.update(), /mounted before update/);
  component.mount();
  assert.throws(() => component.mount(), /already mounted/);
});

test("useState가 초기값과 여러 상태의 호출 순서를 유지한다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  let setCount;
  let setLabel;

  const component = new FunctionComponent(() => {
    const [count, updateCount] = useState(0);
    const [label, updateLabel] = useState("count");
    setCount = updateCount;
    setLabel = updateLabel;
    return view({ message: `${label}: ${count}` });
  }, {}, container, documentRef);

  component.mount();
  setCount((count) => count + 1);
  setLabel("total");

  assert.deepEqual(component.hooks, [1, "total"]);
  assert.equal(component.root.childNodes[1].childNodes[0].nodeValue, "total: 1");
  assert.deepEqual(component.lastPatches, [
    { type: "UPDATE_TEXT", path: [1, 0], value: "total: 1" },
  ]);
});

test("useState setter가 상태 변경 후 자동으로 Diff와 Patch를 실행한다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  let setMessage;
  let renders = 0;

  const component = new FunctionComponent(() => {
    const [message, updateMessage] = useState("Old");
    setMessage = updateMessage;
    renders += 1;
    return view({ message });
  }, {}, container, documentRef);

  component.mount();
  const heading = component.root.childNodes[0];
  setMessage("New");

  assert.equal(renders, 2);
  assert.equal(component.root.childNodes[0], heading);
  assert.equal(component.root.childNodes[1].childNodes[0].nodeValue, "New");
});

test("useState는 FunctionComponent 렌더링 밖에서 호출할 수 없다", () => {
  assert.throws(() => useState(0), /while rendering/);
});

test("루트가 State를 소유하고 자식은 props와 이벤트 함수만 사용한다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  const receivedCounts = [];

  function Display({ count }) {
    receivedCounts.push(count);
    return { type: "p", props: {}, children: [`count: ${count}`] };
  }

  function Controls({ onIncrement }) {
    return { type: "button", props: { onClick: onIncrement }, children: ["증가"] };
  }

  const component = new FunctionComponent(() => {
    const [count, setCount] = useState(0);
    return {
      type: "section",
      props: {},
      children: [
        Display({ count }),
        Controls({ onIncrement: () => setCount((value) => value + 1) }),
      ],
    };
  }, {}, container, documentRef);

  component.mount();
  component.root.childNodes[1].onclick();

  assert.deepEqual(component.hooks, [1]);
  assert.deepEqual(receivedCounts, [0, 1]);
  assert.equal(component.root.childNodes[0].childNodes[0].nodeValue, "count: 1");
});

test("useEffect가 DOM mount 후 실행되고 빈 의존성 배열이면 한 번만 실행된다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  const events = [];
  const component = new FunctionComponent(({ message }) => {
    useEffect(() => {
      events.push(container.childNodes.length ? "effect" : "before-dom");
      return () => events.push("cleanup");
    }, []);
    return view({ message });
  }, { message: "First" }, container, documentRef);

  component.mount();
  component.update({ message: "Second" });
  component.unmount();

  assert.deepEqual(events, ["effect", "cleanup"]);
  assert.equal(container.childNodes.length, 0);
});

test("useEffect가 의존성 변경 시 이전 cleanup 후 다시 실행된다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  const events = [];
  let setCount;
  let setLabel;
  const component = new FunctionComponent(() => {
    const [count, updateCount] = useState(0);
    const [label, updateLabel] = useState("count");
    setCount = updateCount;
    setLabel = updateLabel;
    useEffect(() => {
      events.push(`effect ${count}`);
      return () => events.push(`cleanup ${count}`);
    }, [count]);
    return view({ message: `${label}: ${count}` });
  }, {}, container, documentRef);

  component.mount();
  setLabel("total");
  setCount(1);
  component.unmount();

  assert.deepEqual(events, ["effect 0", "cleanup 0", "effect 1", "cleanup 1"]);
});

test("의존성 배열을 생략한 useEffect는 매 렌더링 후 실행된다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  let runs = 0;
  const component = new FunctionComponent(({ message }) => {
    useEffect(() => {
      runs += 1;
    });
    return view({ message });
  }, { message: "First" }, container, documentRef);

  component.mount();
  component.update({ message: "Second" });

  assert.equal(runs, 2);
});

test("useEffect 인자와 호출 위치를 검증한다", () => {
  assert.throws(() => useEffect(() => {}), /while rendering/);

  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  assert.throws(
    () => new FunctionComponent(() => {
      useEffect("invalid", []);
      return null;
    }, {}, container, documentRef).mount(),
    /requires a function/,
  );
  assert.throws(
    () => new FunctionComponent(() => {
      useEffect(() => {}, "invalid");
      return null;
    }, {}, container, documentRef).mount(),
    /array or undefined/,
  );
});

test("useMemo가 같은 의존성에서 계산 결과를 재사용한다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  let setCount;
  let setLabel;
  let calculations = 0;
  const component = new FunctionComponent(() => {
    const [count, updateCount] = useState(2);
    const [label, updateLabel] = useState("square");
    setCount = updateCount;
    setLabel = updateLabel;
    const squared = useMemo(() => {
      calculations += 1;
      return count * count;
    }, [count]);
    return view({ message: `${label}: ${squared}` });
  }, {}, container, documentRef);

  component.mount();
  setLabel("result");
  assert.equal(calculations, 1);
  assert.equal(component.root.childNodes[1].childNodes[0].nodeValue, "result: 4");

  setCount(3);
  assert.equal(calculations, 2);
  assert.equal(component.root.childNodes[1].childNodes[0].nodeValue, "result: 9");
});

test("useMemo는 빈 배열에서 한 번, 의존성 생략 시 매번 계산한다", () => {
  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  let once = 0;
  let always = 0;
  const component = new FunctionComponent(({ message }) => {
    const stable = useMemo(() => ++once, []);
    const current = useMemo(() => ++always);
    return view({ message: `${message}: ${stable}/${current}` });
  }, { message: "First" }, container, documentRef);

  component.mount();
  component.update({ message: "Second" });

  assert.equal(once, 1);
  assert.equal(always, 2);
});

test("useMemo 인자와 호출 위치를 검증한다", () => {
  assert.throws(() => useMemo(() => 1, []), /while rendering/);

  const documentRef = createDocument();
  const container = documentRef.createElement("main");
  assert.throws(
    () => new FunctionComponent(() => {
      useMemo("invalid", []);
      return null;
    }, {}, container, documentRef).mount(),
    /requires a function/,
  );
  assert.throws(
    () => new FunctionComponent(() => {
      useMemo(() => 1, "invalid");
      return null;
    }, {}, container, documentRef).mount(),
    /array or undefined/,
  );
});
