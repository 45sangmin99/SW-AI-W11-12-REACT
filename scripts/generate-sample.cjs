#!/usr/bin/env node
// 공용 샘플 문의(VOC) JSON 생성기 (요구사항 U-19, 생성 데이터 C4/R-10, 시나리오 18.1.1).
// 가상 회사 OBJECT NOTE의 시연용 데이터다. 실제 문의가 아니다.
// 같은 시드와 옵션이면 항상 같은 파일이 나온다 (재현 가능).
//
//   node scripts/generate-sample.cjs                       -> data/inquiries.sample.json (3,000건)
//   node scripts/generate-sample.cjs --count 5000 --seed 7 --out /tmp/v.json
//
// 평소 문의(기본 잡음) 위에 정의서의 시나리오 6개를 "정해진 시각, 정확한 건수"로 심고,
// 심은 위치를 meta.scenarios(정답지)에 적는다. 화면은 이 정답지를 쓰지 않는다.
// 탐지 로직이 그 사례를 실제로 찾는지, 그 밖의 곳에서 오탐이 없는지 테스트하는 데만 쓴다.
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- 옵션
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const SEED = Number(args.seed ?? 20261109);
const COUNT = Number(args.count ?? 3000);
const UNTIL = args.until ?? "2026-11-09"; // 마지막 날짜 (이 날짜 포함, UTC)
const OUT = args.out ?? path.join(__dirname, "..", "data", "inquiries.sample.json");
const DAYS = 14;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------- 시드 난수 (mulberry32)
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = makeRandom(SEED);
const int = (min, max) => min + Math.floor(random() * (max - min + 1)); // min~max 포함
const pick = (list) => list[Math.floor(random() * list.length)];
function pickWeighted(entries) {
  // entries: [[value, weight], ...]
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = random() * total;
  for (const [value, weight] of entries) {
    r -= weight;
    if (r < 0) return value;
  }
  return entries.at(-1)[0];
}
const orderNo = () => String(int(100000, 999999));

// ---------------------------------------------------------------- 평소 문의
const CATEGORY_WEIGHTS = [
  ["쿠폰·할인", 0.18], ["사이즈·교환", 0.17], ["반품·환불", 0.17], ["로그인·계정", 0.1],
  ["배송", 0.2], ["적립금·포인트", 0.08], ["기타", 0.1],
];
const DEVICE_WEIGHTS = [["iOS", 0.42], ["Android", 0.4], ["Web", 0.18]];
// 하루 중 시간대별 문의 비중 (밤에는 적고 점심·저녁에 많다)
const HOUR_WEIGHTS = [
  0.012, 0.012, 0.012, 0.012, 0.012, 0.012, 0.012, 0.02, 0.035, 0.055, 0.055, 0.055,
  0.07, 0.07, 0.06, 0.06, 0.06, 0.06, 0.055, 0.065, 0.065, 0.065, 0.065, 0.04,
].map((w, h) => [h, w]);
const VERSION_RELEASE_DAYS_BEFORE_UNTIL = 1; // 앱 4.4.0은 마지막 날 하루 전(UNTIL-1)부터 배포
const versionFor = (device, daysBeforeUntil) => {
  if (device === "Web") return "web";
  return daysBeforeUntil <= VERSION_RELEASE_DAYS_BEFORE_UNTIL
    ? pickWeighted([["4.2.0", 0.15], ["4.3.0", 0.45], ["4.4.0", 0.4]])
    : pickWeighted([["4.2.0", 0.3], ["4.3.0", 0.7]]);
};

// 평소 문의 문장. 한 시간에 같은 문장이 10건 넘게 나오기는 어렵도록 유형마다 여러 개를 둔다.
const BASE_TEXTS = {
  "쿠폰·할인": ["쿠폰은 어디서 확인하나요?", "할인 쿠폰 유효기간이 궁금해요.", "쿠폰 중복 사용이 가능한가요?", "첫 구매 쿠폰이 안 보여요.", "적용 가능한 쿠폰이 없다고 나와요.", "생일 쿠폰은 언제 발급되나요?", "쿠폰 사용 조건을 알려주세요.", "장바구니 쿠폰 적용 방법이 궁금해요."],
  "사이즈·교환": ["사이즈가 작아서 교환하고 싶어요.", "사이즈표 기준이 어떻게 되나요?", "한 치수 큰 걸로 교환 가능한가요?", "교환 신청은 어디서 하나요?", "모델 착용 사이즈가 궁금해요.", "교환 배송비는 얼마인가요?", "사이즈 추천 부탁드려요.", "교환 접수했는데 언제 처리되나요?"],
  "반품·환불": ["반품 신청 방법을 알려주세요.", "환불은 언제 입금되나요?", "단순 변심 반품도 가능한가요?", "반품 택배는 언제 오나요?", "환불 계좌를 변경하고 싶어요.", "반품 기간이 지났는데 가능한가요?", "부분 환불이 되나요?", "반품 접수를 취소하고 싶어요."],
  "로그인·계정": ["비밀번호를 잊어버렸어요.", "로그인이 가끔 풀려요.", "회원 탈퇴는 어떻게 하나요?", "이메일 주소를 변경하고 싶어요.", "인증번호가 오지 않아요.", "계정이 잠겼다고 나와요.", "휴면 계정을 풀고 싶어요.", "간편 로그인 연동을 해제하고 싶어요."],
  "배송": ["배송은 언제 오나요?", "배송지를 변경하고 싶어요.", "택배사가 어디인가요?", "송장번호가 조회되지 않아요.", "배송 전에 취소할 수 있나요?", "부재중이라 재배송을 요청드려요.", "묶음 배송이 가능한가요?", "배송 예정일이 궁금해요."],
  "적립금·포인트": ["적립금은 언제 사용할 수 있나요?", "포인트 유효기간이 궁금해요.", "적립률이 얼마인가요?", "적립금 사용 한도가 있나요?", "리뷰 적립금은 언제 들어오나요?", "포인트 소멸 예정일을 알려주세요.", "적립금으로 전액 결제가 되나요?", "회원 등급별 적립률이 다른가요?"],
  "기타": ["입점 문의는 어디로 하나요?", "오프라인 매장이 있나요?", "상품 재입고 알림이 되나요?", "영수증 발급 방법이 궁금해요.", "상품 상세 정보가 틀린 것 같아요.", "선물 포장이 가능한가요?", "단체 주문 문의드려요.", "앱 알림 설정은 어디서 하나요?"],
};
const baseText = (category) => {
  const text = pick(BASE_TEXTS[category]);
  return random() < 0.4 ? `${text} 주문번호 ${orderNo()}` : text; // 주문번호는 반복 문구 비교에서 #으로 가려진다
};

// ---------------------------------------------------------------- 시나리오 (정의서 18.1.1)
// perHour: 정해진 시간대에 매시간 정확히 이 건수를 넣는다 (임계값을 안정적으로 넘기기 위함)
// mainShare: 그 중 같은 문장(main)으로 쓰는 비율. 나머지는 others를 돌려 쓴다.
const SCENARIOS = [
  {
    id: 1, name: "브랜드 위크 세일 중 쿠폰이 적용된 것처럼 보이지만 결제 금액에 반영되지 않음",
    category: "쿠폰·할인", expect: ["surge", "repeat"],
    windows: [{ daysBefore: 2, from: 10, to: 13 }], perHour: 35, mainShare: 0.8,
    main: () => `주문번호 ${orderNo()} 쿠폰이 적용됐다고 나오는데 결제 금액이 그대로예요`,
    others: ["쿠폰 적용이 안 되고 원래 금액으로 결제됐어요.", "브랜드 위크 쿠폰이 결제 화면에서 사라졌어요.", "할인이 적용된 줄 알았는데 정가로 빠져나갔어요.", "쿠폰 적용 표시와 실제 결제 금액이 달라요."],
  },
  {
    id: 2, name: "상품 상세 개편 후 사이즈표 위치가 바뀌어 사이즈 정보·교환 문의 증가",
    category: "사이즈·교환", expect: ["category"],
    windows: [{ daysBefore: 5, from: 11, to: 19 }, { daysBefore: 4, from: 11, to: 19 }], perHour: 16, mainShare: 0,
    others: ["사이즈표가 어디 있는지 못 찾겠어요.", "상품 상세에서 사이즈 정보가 안 보여요.", "사이즈표가 없어졌어요 어디서 보나요?", "사이즈 정보가 바뀐 것 같아요 다시 알려주세요.", "교환하려는데 사이즈 기준을 모르겠어요."],
  },
  {
    id: 3, name: "반품 정책 문구 변경 후 \"반품비가 왜 나왔어요?\" 문의 쏠림",
    category: "반품·환불", expect: ["category", "repeat"],
    windows: [{ daysBefore: 1, from: 9, to: 20 }], perHour: 16, mainShare: 0.75,
    main: () => `주문번호 ${orderNo()} 반품비가 왜 나왔어요?`,
    others: ["반품 정책이 바뀐 건가요?", "반품비 기준이 어떻게 되나요?", "무료 반품이라고 봤는데요.", "반품비를 돌려받을 수 있나요?"],
  },
  {
    id: 4, name: "앱 업데이트 후 Android에서만 소셜 로그인 실패",
    category: "로그인·계정", expect: ["env", "surge"],
    windows: [{ daysBefore: 0, from: 9, to: 12 }], perHour: 30, mainShare: 0,
    device: "Android", version: "4.4.0",
    others: ["소셜 로그인하면 오류가 나면서 앱이 멈춰요.", "카카오 로그인이 계속 실패해요.", "구글 로그인 버튼을 누르면 아무 반응이 없어요.", "업데이트하고 나서 로그인이 안 돼요.", "로그인 화면에서 계속 로딩만 돼요."],
  },
  {
    id: 5, name: "특정 입점 브랜드(노트블랙) 주문만 배송 상태가 며칠째 바뀌지 않음",
    category: "배송", expect: ["surge"],
    windows: [{ daysBefore: 3, from: 14, to: 18 }], perHour: 22, mainShare: 0,
    others: ["노트블랙 주문한 건데 배송 상태가 며칠째 그대로예요.", "노트블랙 상품 배송 조회가 계속 같은 상태예요.", "노트블랙 주문이 배송 준비중에서 안 바뀌어요.", "노트블랙에서 산 옷이 아직도 출고가 안 됐어요.", "노트블랙 배송이 너무 늦어요 언제 오나요?", "노트블랙 주문 건 배송 상태 확인 부탁드려요."],
  },
  {
    id: 6, name: "구매 확정 후 적립금이 들어오지 않음",
    category: "적립금·포인트", expect: ["repeat"],
    windows: [{ daysBefore: 4, from: 3, to: 5 }], perHour: 12, mainShare: 1, // 새벽 시간대라 전체 문의가 적어 '유형 쏠림'은 판단되지 않는다
    main: () => `주문번호 ${orderNo()} 구매 확정했는데 적립금이 들어오지 않았어요`,
    others: [],
  },
];

// ---------------------------------------------------------------- 만들기
const untilStart = Date.parse(`${UNTIL}T00:00:00Z`);
const dayStart = (daysBefore) => untilStart - daysBefore * DAY_MS;
const iso = (ms) => new Date(ms).toISOString();
const hourKey = (ms) => iso(ms).slice(0, 13);

const rows = [];
const addRow = (category, text, device, version, ms) =>
  rows.push({ category, text, app_version: version, device, created_at: iso(ms) });

const extraTotal = SCENARIOS.reduce(
  (sum, s) => sum + s.windows.reduce((w, win) => w + (win.to - win.from + 1) * s.perHour, 0), 0,
);
const baseTotal = COUNT - extraTotal;
if (baseTotal < 300) throw new Error("--count가 너무 작습니다. (시나리오만 " + extraTotal + "건)");

// 평소 문의: 날짜는 고르게, 시각은 비중대로
for (let i = 0; i < baseTotal; i++) {
  const daysBefore = int(0, DAYS - 1);
  const hour = pickWeighted(HOUR_WEIGHTS);
  const category = pickWeighted(CATEGORY_WEIGHTS);
  const device = pickWeighted(DEVICE_WEIGHTS);
  const ms = dayStart(daysBefore) + hour * HOUR_MS + int(0, 3599) * 1000;
  addRow(category, baseText(category), device, versionFor(device, daysBefore), ms);
}

// 시나리오: 정해진 시각에 정확한 건수
for (const s of SCENARIOS) {
  for (const win of s.windows) {
    for (let hour = win.from; hour <= win.to; hour++) {
      const mainCount = Math.floor(s.perHour * s.mainShare);
      for (let k = 0; k < s.perHour; k++) {
        const text = k < mainCount ? s.main() : s.others[(k - mainCount) % s.others.length];
        const device = s.device ?? pickWeighted(DEVICE_WEIGHTS);
        const version = s.version ?? versionFor(device, win.daysBefore);
        addRow(s.category, text, device, version, dayStart(win.daysBefore) + hour * HOUR_MS + int(0, 3599) * 1000);
      }
    }
  }
}

// 시간순으로 정렬한 뒤 id를 부여한다 (DBMS가 자동 부여하는 id를 흉내냄: 먼저 들어온 문의가 작은 id)
rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.category.localeCompare(b.category) || a.text.localeCompare(b.text));
const inquiries = rows.map((row, i) => ({ id: i + 1, ...row }));

const meta = {
  generated: true,
  company: "OBJECT NOTE (가상의 회사)",
  note: "시연용 생성 데이터입니다. 실제 고객 문의가 아닙니다.",
  seed: SEED,
  count: inquiries.length,
  from: hourKey(dayStart(DAYS - 1)),
  until: hourKey(untilStart + 23 * HOUR_MS),
  scenarios: SCENARIOS.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    expect: s.expect,
    windows: s.windows.map((win) => ({ start: hourKey(dayStart(win.daysBefore) + win.from * HOUR_MS), end: hourKey(dayStart(win.daysBefore) + win.to * HOUR_MS) })),
  })),
};

// 문의는 한 줄에 하나씩 (git diff와 눈으로 보기 쉽게)
const json = `{\n  "meta": ${JSON.stringify(meta)},\n  "inquiries": [\n${inquiries.map((r) => "    " + JSON.stringify(r)).join(",\n")}\n  ]\n}\n`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, json);
console.log(`${inquiries.length}건 -> ${OUT} (seed=${SEED}, ${meta.from} ~ ${meta.until}, 시나리오 ${extraTotal}건 + 평소 ${baseTotal}건)`);
