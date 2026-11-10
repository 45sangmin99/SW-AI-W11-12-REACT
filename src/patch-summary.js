const patchLabels = {
  CREATE: "노드 생성",
  REMOVE: "노드 삭제",
  REPLACE: "노드 교체",
  UPDATE_TEXT: "텍스트 수정",
  UPDATE_PROPS: "속성 수정",
  MOVE: "목록 이동",
};

export function summarizePatches(patches) {
  if (patches.length === 0) {
    return "변경 없음 · 실제 영역을 그대로 유지했습니다.";
  }

  const counts = new Map();
  for (const { type } of patches) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  const changes = Array.from(
    counts,
    ([type, count]) => `${patchLabels[type] ?? type} ${count}개`,
  );
  return `${changes.join(" · ")} · 총 ${patches.length}개 변경`;
}

export function summarizeComponentUpdate(action, stateName, patches) {
  const rootReplaced = patches.some(
    ({ type, path = [] }) => type === "REPLACE" && path.length === 0,
  );
  const domResult = rootReplaced ? "루트 DOM 교체" : "루트 DOM 재사용";
  return `${action} · ${stateName} State 변경 · Component 재실행 · ${summarizePatches(patches)} · ${domResult}`;
}
