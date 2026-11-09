#!/usr/bin/env node
// 공용 샘플 리뷰 JSON 생성기 (요구사항 U-19, 생성 데이터 C4/R-10의 축소판).
// 같은 시드와 옵션이면 항상 같은 파일이 나온다 (재현 가능).
//
//   node scripts/generate-sample.cjs                       -> data/reviews.sample.json (1,000건)
//   node scripts/generate-sample.cjs --count 5000 --seed 7 --out /tmp/r.json
//
// 이상 패턴 3종을 의도적으로 심어 두고, 심은 위치를 meta.planted(정답지)에 적는다.
// 이 정답지는 화면이 쓰지 않는다. 탐지 로직이 실제로 그 사례를 찾는지 테스트하는 데만 쓴다.
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- 옵션
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
);
const SEED = Number(args.seed ?? 20261109);
const COUNT = Number(args.count ?? 1000);
const UNTIL = args.until ?? "2026-11-09"; // 마지막 리뷰 날짜 (이 날짜 포함)
const OUT = args.out ?? path.join(__dirname, "..", "data", "reviews.sample.json");
const DAYS = 90;
const PRODUCTS = Array.from({ length: 8 }, (_, i) => `prod-${String(i + 1).padStart(3, "0")}`);
const DAY_MS = 86_400_000;

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

// ---------------------------------------------------------------- 심어 둘 이상 패턴
const SURGE = [
  { product_id: "prod-003", offset: 12, extra: 40 }, // 하루에 40건 추가 (강한 급증)
  { product_id: "prod-006", offset: 30, extra: 9 }, //  하루에 9건 추가 (약한 급증)
];
const SKEW = {
  "prod-002": [0.93, 0.02, 0.02, 0.01, 0.02], // 1점 93% (강한 쏠림)
  "prod-007": [0.04, 0.04, 0.05, 0.09, 0.78], // 5점 78% (약한 쏠림)
};
const SPAM = {
  "prod-005": {
    sentence: "이 제품 덕분에 인생이 바뀌었어요 지금 링크에서 최저가로 구매하세요",
    offsets: [5, 5, 5, 6, 6, 6, 7, 7, 20, 20, 20, 21, 21, 21], // 14건
  },
  "prod-008": {
    sentence: "지금 구매하면 사은품 증정 이벤트 진행 중이니 프로필 링크를 확인하세요",
    offsets: [2, 2, 3, 4], // 4건
  },
};
const DEFAULT_WEIGHTS = [0.08, 0.1, 0.17, 0.3, 0.35]; // 별점 1~5 비율

// ---------------------------------------------------------------- 문장 만들기
// 문장마다 "사용 N일차"를 붙여 우연히 같은 문장이 3번 이상 나오지 않게 한다 (심은 반복 문구만 탐지되도록).
const ASPECTS = ["배송", "포장", "품질", "디자인", "가격", "사이즈", "색감", "마감", "소재", "성능", "배터리", "소음", "설치", "사용감", "고객 응대"];
const PREDICATES = {
  positive: ["만족스러워요", "기대 이상이에요", "훌륭합니다", "괜찮았어요", "마음에 들어요", "깔끔해요", "튼튼해요", "세련됐어요", "가성비가 좋아요", "완벽해요"],
  neutral: ["보통이에요", "무난해요", "그럭저럭이에요", "평범했어요", "기대만큼은 아니었어요", "나쁘지 않아요", "조금 아쉬워요", "쓸 만해요", "가격만큼이에요", "차이를 모르겠어요"],
  negative: ["실망스러워요", "기대 이하예요", "별로예요", "불편했어요", "품질이 떨어져요", "문제가 있었어요", "다시는 안 살래요", "아쉬움이 커요", "환불하고 싶어요", "최악이에요"],
};
const CLOSERS = ["추천해요", "강추", "만족", "재구매", "굿", "별로"]; // 정규화 길이 8 미만 → 반복 문구로 잡히지 않는다

const tone = (rating) => (rating >= 4 ? "positive" : rating === 3 ? "neutral" : "negative");
const sentence = (rating) => `${pick(ASPECTS)} 부분은 ${pick(PREDICATES[tone(rating)])} (사용 ${int(1, 120)}일차)`;

function makeText(rating) {
  const parts = [sentence(rating)];
  if (random() < 0.5) parts.push(sentence(rating));
  if (random() < 0.3) parts.push(pick(CLOSERS));
  return parts.join(". ") + ".";
}

function pickRating(weights) {
  let r = random();
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i + 1;
  }
  return weights.length;
}

// ---------------------------------------------------------------- 리뷰 만들기
const untilStart = Date.parse(`${UNTIL}T00:00:00Z`);
const timeOf = (offset) => untilStart - offset * DAY_MS + int(8 * 3600, 23 * 3600 + 3599) * 1000; // 하루 중 08:00~23:59

const make = (product_id, offset, rating, text) => ({
  product_id,
  rating,
  text,
  created_at: new Date(timeOf(offset)).toISOString(),
});

const extras = SURGE.reduce((sum, s) => sum + s.extra, 0);
const baseTotal = COUNT - extras;
if (baseTotal < PRODUCTS.length) throw new Error("--count가 너무 작습니다.");

const rows = [];
PRODUCTS.forEach((product_id, index) => {
  const baseCount = Math.floor(baseTotal / PRODUCTS.length) + (index < baseTotal % PRODUCTS.length ? 1 : 0);
  const weights = SKEW[product_id] ?? DEFAULT_WEIGHTS;
  const spam = SPAM[product_id];
  for (let i = 0; i < baseCount; i++) {
    const rating = pickRating(weights);
    if (spam && i < spam.offsets.length) {
      rows.push(make(product_id, spam.offsets[i], rating, `${makeText(rating)} ${spam.sentence}!`));
    } else {
      rows.push(make(product_id, int(0, DAYS - 1), rating, makeText(rating)));
    }
  }
});
for (const s of SURGE) {
  for (let i = 0; i < s.extra; i++) {
    const rating = pickRating(DEFAULT_WEIGHTS);
    rows.push(make(s.product_id, s.offset, rating, makeText(rating)));
  }
}

// 시간순으로 정렬한 뒤 id를 부여한다 (DBMS가 자동 부여하는 id를 흉내냄: 먼저 쓴 리뷰가 작은 id)
rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.product_id.localeCompare(b.product_id));
const reviews = rows.map((row, i) => ({ id: i + 1, ...row }));

const day = (offset) => new Date(untilStart - offset * DAY_MS).toISOString().slice(0, 10);
const meta = {
  generated: true,
  note: "시연용 생성 데이터입니다. 실제 리뷰가 아닙니다.",
  seed: SEED,
  count: reviews.length,
  from: day(DAYS - 1),
  until: UNTIL,
  products: PRODUCTS,
  planted: {
    surge: SURGE.map((s) => ({ product_id: s.product_id, date: day(s.offset), extra: s.extra })),
    skew: Object.entries(SKEW).map(([product_id, w]) => ({ product_id, rating: w.indexOf(Math.max(...w)) + 1, weight: Math.max(...w) })),
    repeat: Object.entries(SPAM).map(([product_id, s]) => ({ product_id, sentence: s.sentence, reviews: s.offsets.length })),
  },
};

// 리뷰는 한 줄에 하나씩 (git diff와 눈으로 보기 쉽게)
const json = `{\n  "meta": ${JSON.stringify(meta)},\n  "reviews": [\n${reviews.map((r) => "    " + JSON.stringify(r)).join(",\n")}\n  ]\n}\n`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, json);
console.log(`${reviews.length}건 -> ${OUT} (seed=${SEED}, ${meta.from} ~ ${meta.until})`);
