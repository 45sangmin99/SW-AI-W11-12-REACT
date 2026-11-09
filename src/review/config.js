// 리뷰 이상 탐지 기준값 모음 (요구사항 U-14, U-22, U-23, U-24).
// 원문이 정하지 않은 값이라 한곳에 모아 두었다. 기준을 바꾸고 싶으면 이 파일만 고치면 된다.
export const CONFIG = Object.freeze({
  // ---- 리뷰 급증 (U-14): 상품별 일 단위 리뷰 수가 "평균 + SURGE_Z × 표준편차" 이상이고 SURGE_MIN_COUNT건 이상인 날
  SURGE_Z: 2,
  SURGE_MIN_COUNT: 8, // 적은 건수의 우연한 튐을 급증으로 보지 않기 위한 최소 건수
  SURGE_MIN_DAYS: 14, // 평소 수준(평균·표준편차)을 구할 최소 일수. 이보다 짧은 기간은 판단하지 않는다
  // 심각도 (U-22): 가장 큰 날의 z 값(표준편차의 몇 배)
  SURGE_Z_MEDIUM: 4,
  SURGE_Z_HIGH: 7,

  // ---- 평점 쏠림: 한 평점이 SKEW_RATIO 이상이고 SKEW_MIN_REVIEWS건 이상
  SKEW_MIN_REVIEWS: 20,
  SKEW_RATIO: 0.7,
  SKEW_RATIO_MEDIUM: 0.8,
  SKEW_RATIO_HIGH: 0.85,

  // ---- 반복 문구: 정규화한 문장이 서로 다른 리뷰 REPEAT_MIN_REVIEWS건 이상에 나타남
  REPEAT_MIN_REVIEWS: 3,
  REPEAT_MIN_PHRASE_LEN: 8, // "좋아요" 같은 짧은 말은 반복돼도 이상으로 보지 않는다 (정규화한 글자 수)
  REPEAT_MEDIUM: 6, // 반복 문구가 들어간 리뷰 수
  REPEAT_HIGH: 10,

  // ---- 화면 (U-23, U-24)
  PAGE_SIZE: 5, // 근거 리뷰 한 페이지의 건수
  TEXT_MAX: 500, // 리뷰 작성 내용의 최대 글자 수
  RATING_MIN: 1,
  RATING_MAX: 5,

  // 기간 필터: 데이터에서 가장 최근 리뷰 날짜를 기준으로 "최근 N일"을 센다 (days: null = 전체)
  PERIODS: Object.freeze([
    Object.freeze({ value: "all", label: "전체 기간", days: null }),
    Object.freeze({ value: "7", label: "최근 7일", days: 7 }),
    Object.freeze({ value: "30", label: "최근 30일", days: 30 }),
    Object.freeze({ value: "60", label: "최근 60일", days: 60 }),
  ]),
});
