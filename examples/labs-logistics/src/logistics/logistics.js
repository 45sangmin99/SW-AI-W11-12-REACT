import { FunctionComponent, useEffect, useMemo, useState } from "../engine/component.js";

const origin = "출발 허브";
const sharedLeg = { to: "분류 허브", distanceKm: 3.2 };
const routes = {
  east: [sharedLeg, { to: "동부 배송지", distanceKm: 2 }],
  west: [sharedLeg, { to: "서부 배송지", distanceKm: 3 }],
  south: [sharedLeg, { to: "남부 배송지", distanceKm: 4 }],
};
const vehicles = [
  { id: "T-01", speedKmh: 60, routeId: "east" },
  { id: "T-02", speedKmh: 45, routeId: "west" },
  { id: "T-03", speedKmh: 36, routeId: "south" },
];
const shipmentCounts = { "T-01": 3, "T-02": 2, "T-03": 4 };
const points = {
  [origin]: { x: 15, y: 50 },
  [sharedLeg.to]: { x: 50, y: 50 },
  "동부 배송지": { x: 85, y: 21 },
  "서부 배송지": { x: 85, y: 50 },
  "남부 배송지": { x: 85, y: 79 },
};

function routeStops(legs) {
  return [origin, ...legs.map(({ to }) => to)];
}

function routeLength(legs) {
  return legs.reduce((total, leg) => total + leg.distanceKm * 1000, 0);
}

function metersPerMinute(speedKmh) {
  return speedKmh * 1000 / 60;
}

const fleet = vehicles.map((vehicle) => ({
  ...vehicle,
  distance: 0,
  length: routeLength(routes[vehicle.routeId]),
}));
const totalShipments = Object.values(shipmentCounts).reduce((total, count) => total + count, 0);

function advanceFleet(previous) {
  if (previous.vehicles.every(({ distance, length }) => distance === length)) return previous;

  const arrivals = [];
  const nextVehicles = previous.vehicles.map((vehicle) => {
    if (vehicle.distance === vehicle.length) return vehicle;

    const stepDistance = metersPerMinute(vehicle.speedKmh);
    const distance = Math.min(vehicle.distance + stepDistance, vehicle.length);
    let boundary = 0;
    let from = origin;
    for (const leg of routes[vehicle.routeId]) {
      boundary += leg.distanceKm * 1000;
      if (vehicle.distance < boundary && distance >= boundary) {
        arrivals.push({
          id: vehicle.id,
          from,
          to: leg.to,
          time: (boundary - vehicle.distance) / stepDistance,
        });
      }
      from = leg.to;
    }
    return { ...vehicle, distance };
  });

  return {
    minute: previous.minute + 1,
    vehicles: nextVehicles,
    running: previous.running && nextVehicles.some(({ distance, length }) => distance < length),
    moves: [...previous.moves, ...arrivals.sort((a, b) => a.time - b.time)],
  };
}

function vehiclePosition({ routeId, distance }) {
  let remaining = distance;
  let from = origin;
  for (const { to, distanceKm } of routes[routeId]) {
    const length = distanceKm * 1000;
    if (remaining <= length) {
      const start = points[from];
      const end = points[to];
      const progress = remaining / length;
      return {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
        shared: from === origin,
        progress,
      };
    }
    remaining -= length;
    from = to;
  }
}

function MapEdge({ from, to, traveled }) {
  const start = points[from];
  const end = points[to];
  return {
    type: "span",
    props: {
      class: traveled ? "hub-edge is-traveled" : "hub-edge",
      "aria-hidden": "true",
      style: `--from-x:${start.x}%;--from-y:${start.y}%;--to-x:${end.x}%;--to-y:${end.y}%`,
    },
    children: [],
  };
}

function NetworkMap({ vehicles, waiting }) {
  return {
    type: "div",
    props: { class: "hub-map" },
    children: [
      {
        type: "ol",
        props: { class: "hub-route", role: "list", "aria-label": "물류 허브" },
        children: Object.entries(points).map(([name, { x, y }]) => ({
          type: "li",
          props: { class: "hub", style: `left:${x}%;top:${y}%` },
          children: [
            { type: "strong", props: { class: "hub-name" }, children: [name] },
            ...(name === origin
              ? [{ type: "span", props: { class: "hub-queue" }, children: [`대기 ${waiting}건`] }]
              : []),
          ],
        })),
      },
      MapEdge({
        from: origin,
        to: sharedLeg.to,
        traveled: vehicles.some(({ distance }) => distance >= sharedLeg.distanceKm * 1000),
      }),
      ...vehicles.map(({ routeId, distance, length }) => MapEdge({
        from: sharedLeg.to,
        to: routes[routeId].at(-1).to,
        traveled: distance === length,
      })),
      ...vehicles.map((vehicle, index) => {
        const { x, y, shared, progress } = vehiclePosition(vehicle);
        // Keep the same side at the fork, then gradually merge onto the destination road.
        const lane = [-54, 0, 54][index] * (shared ? 1 : 1 - progress);
        return {
          type: "div",
          props: {
            class: "cargo-marker",
            "aria-hidden": "true",
            "data-vehicle": vehicle.id,
            style: `left:${x}%;top:${y}%;--lane:${lane}px`,
          },
          children: [
            { type: "span", props: { class: "cargo-id" }, children: [`${vehicle.id} · ${shipmentCounts[vehicle.id]}건`] },
            { type: "span", props: { class: "cargo-truck" }, children: ["🚚"] },
          ],
        };
      }),
    ],
  };
}

function ShipmentSummary({ waiting, inTransit, completed, completionRate }) {
  return {
    type: "section",
    props: { "aria-labelledby": "shipment-summary-title" },
    children: [
      { type: "h3", props: { id: "shipment-summary-title" }, children: ["화물 처리 현황"] },
      {
        type: "dl",
        props: {},
        children: [["대기", `${waiting}건`], ["배송 중", `${inTransit}건`], ["완료", `${completed}건`], ["완료율", `${completionRate}%`]]
          .map(([label, value]) => ({
            type: "div",
            props: {},
            children: [
              { type: "dt", props: {}, children: [label] },
              { type: "dd", props: {}, children: [value] },
            ],
          })),
      },
    ],
  };
}

function MovementLog({ moves }) {
  return {
    type: "section",
    props: { "aria-labelledby": "movement-log-title" },
    children: [
      { type: "h3", props: { id: "movement-log-title" }, children: ["최근 이동 기록"] },
      moves.length === 0
        ? { type: "p", props: {}, children: ["아직 이동 기록이 없습니다."] }
        : {
          type: "ol",
          props: {},
          children: moves.map(({ id, from, to }) => ({
            type: "li",
            props: {},
            children: [`${id} · ${from} → ${to}`],
          })),
        },
    ],
  };
}

function DispatchPlan({ vehicles, minute, fastestFirst, onSortChange }) {
  const ordered = vehicles.map((vehicle) => {
    const { distance, length, speedKmh } = vehicle;
    const completed = distance === length;
    const pace = metersPerMinute(speedKmh);
    const arrivalMinute = completed ? Math.ceil(length / pace) : minute + Math.ceil((length - distance) / pace);
    return { ...vehicle, completed, arrivalMinute };
  }).sort((a, b) => fastestFirst ? a.arrivalMinute - b.arrivalMinute : b.arrivalMinute - a.arrivalMinute);

  return {
    type: "section",
    props: { "aria-labelledby": "dispatch-plan-title" },
    children: [
      { type: "h3", props: { id: "dispatch-plan-title" }, children: ["차량 배차 계획"] },
      {
        type: "label",
        props: { class: "dispatch-sort" },
        children: [
          "정렬 ",
          {
            type: "select",
            props: { onChange: onSortChange },
            children: [
              { type: "option", props: { value: "fastest" }, children: ["도착이 빠른 순"] },
              { type: "option", props: { value: "slowest" }, children: ["도착이 늦은 순"] },
            ],
          },
        ],
      },
      {
        type: "ol",
        props: { class: "dispatch-list" },
        children: ordered.map(({ id, speedKmh, routeId, distance, length, completed, arrivalMinute }) => {
          const legs = routes[routeId];
          const status = distance === 0 ? "출발 대기" : completed ? "배송 완료" : "배송 중";
          const arrival = completed ? "배송 완료" : `도착 예상: 경과 ${arrivalMinute}분`;
          return {
            type: "li",
            props: { key: id },
            children: [
              {
                type: "details",
                props: {},
                children: [
                  {
                    type: "summary",
                    props: {},
                    children: [
                      { type: "strong", props: {}, children: [id] },
                      ` · ${legs.at(-1).to}`,
                      { type: "span", props: { class: "dispatch-arrival" }, children: [arrival] },
                    ],
                  },
                  { type: "p", props: {}, children: [`화물 ${shipmentCounts[id]}건 · ${speedKmh}km/h`] },
                  { type: "p", props: {}, children: [`${routeStops(legs).join(" → ")} · ${(length / 1000).toFixed(1)}km`] },
                  { type: "p", props: {}, children: [`${status} · ${(distance / 1000).toFixed(2)}km 이동`] },
                ],
              },
            ],
          };
        }),
      },
    ],
  };
}

const initialSimulation = { minute: 0, vehicles: fleet, running: false, moves: [] };

export function LogisticsSimulator() {
  const [{ minute, vehicles, running, moves }, setSimulation] = useState(initialSimulation);
  const [fastestFirst, setFastestFirst] = useState(true);
  const summary = useMemo(() => {
    let waiting = 0;
    let completed = 0;
    for (const { id, distance, length } of vehicles) {
      if (distance === 0) waiting += shipmentCounts[id];
      else if (distance === length) completed += shipmentCounts[id];
    }
    return {
      waiting,
      completed,
      inTransit: totalShipments - waiting - completed,
      completionRate: Math.round(completed / totalShipments * 100),
    };
  }, [vehicles]);
  const arrived = summary.completed === totalShipments;

  function advance() {
    setSimulation(advanceFleet);
  }

  function rewind() {
    setSimulation((previous) => {
      if (previous.running || previous.minute === 0) return previous;

      // shortcut: replay the fixed scenario, store snapshots if runs become long or nondeterministic.
      let snapshot = initialSimulation;
      while (snapshot.minute < previous.minute - 1) snapshot = advanceFleet(snapshot);
      return snapshot;
    });
  }

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(advance, 1000);
    return () => clearInterval(timer);
  }, [running]);

  return {
    type: "section",
    props: { class: "logistics-panel", "aria-labelledby": "route-title" },
    children: [
      {
        type: "div",
        props: { class: "logistics-heading" },
        children: [
          { type: "h2", props: { id: "route-title" }, children: ["물류 네트워크"] },
          { type: "span", props: { class: "logistics-key" }, children: ["🚚 차량 현재 위치"] },
        ],
      },
      NetworkMap({ vehicles, waiting: summary.waiting }),
      {
        type: "div",
        props: { class: "controls" },
        children: [
          {
            type: "div",
            props: { class: "step-controls", role: "group", "aria-label": "수동 진행" },
            children: [
              {
                type: "button",
                props: running || minute === 0
                  ? { type: "button", class: "button-secondary", disabled: "" }
                  : { type: "button", class: "button-secondary", onClick: rewind },
                children: ["한 단계 이전"],
              },
              {
                type: "button",
                props: arrived || running
                  ? { type: "button", disabled: "" }
                  : { type: "button", onClick: advance },
                children: ["한 단계 진행"],
              },
            ],
          },
          {
            type: "button",
            props: arrived
              ? { type: "button", class: "button-secondary", disabled: "" }
              : {
                type: "button",
                class: "button-secondary",
                onClick: () => setSimulation((previous) => ({
                  ...previous,
                  running: !running && previous.vehicles.some(({ distance, length }) => distance < length),
                })),
              },
            children: [running ? "자동 진행 정지" : "자동 진행 시작"],
          },
        ],
      },
      {
        type: "p",
        props: { class: "logistics-status", role: "status" },
        children: [arrived
          ? `모든 차량이 도착했습니다. · 경과 ${minute}분`
          : `${running ? "자동 진행 중" : minute === 0 ? "출발 대기" : "일시 정지"} · 경과 ${minute}분`],
      },
      {
        type: "div",
        props: { class: "logistics-details" },
        children: [
          ShipmentSummary(summary),
          MovementLog({ moves }),
          DispatchPlan({
            vehicles, minute, fastestFirst,
            onSortChange: (event) => setFastestFirst(event.target.value === "fastest"),
          }),
        ],
      },
    ],
  };
}

const container = globalThis.document?.querySelector("#hub-route");
if (container) new FunctionComponent(LogisticsSimulator, {}, container).mount();
