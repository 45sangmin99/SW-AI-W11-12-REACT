import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeComponentUpdate, summarizePatches } from "../src/patch-summary.js";

test("변경이 없으면 실제 영역이 유지됐다고 설명한다", () => {
  assert.equal(
    summarizePatches([]),
    "변경 없음 · 실제 영역을 그대로 유지했습니다.",
  );
});

test("Patch 종류별 개수와 전체 개수를 설명한다", () => {
  assert.equal(
    summarizePatches([
      { type: "UPDATE_TEXT" },
      { type: "REMOVE" },
      { type: "UPDATE_TEXT" },
    ]),
    "텍스트 수정 2개 · 노드 삭제 1개 · 총 3개 변경",
  );
});

test("모든 Diff Patch 종류를 사람이 읽을 수 있는 이름으로 바꾼다", () => {
  assert.equal(
    summarizePatches([
      { type: "CREATE" },
      { type: "REPLACE" },
      { type: "UPDATE_PROPS" },
      { type: "MOVE" },
    ]),
    "노드 생성 1개 · 노드 교체 1개 · 속성 수정 1개 · 목록 이동 1개 · 총 4개 변경",
  );
});

test("사용자 행동부터 State와 Component, Patch, DOM 재사용까지 연결한다", () => {
  assert.equal(
    summarizeComponentUpdate(
      "완료 상태 변경",
      "todos",
      [{ type: "UPDATE_TEXT", path: [2, 0] }],
    ),
    "완료 상태 변경 · todos State 변경 · Component 재실행 1회 · 텍스트 수정 1개 · 총 1개 변경 · 루트 DOM 재사용",
  );
});

test("루트 REPLACE는 DOM 교체로 설명한다", () => {
  assert.match(
    summarizeComponentUpdate("화면 변경", "view", [{ type: "REPLACE", path: [] }]),
    /루트 DOM 교체$/,
  );
});

test("렌더가 없으면 상태 변경이나 Patch를 보고하지 않는다", () => {
  assert.equal(
    summarizeComponentUpdate("필터 변경", "filter", [], 0),
    "필터 변경 · State 변경 없음 · Component 재실행 0회",
  );
});
