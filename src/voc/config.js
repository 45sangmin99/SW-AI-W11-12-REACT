// 고객 문의(VOC) 이상 탐지 기준값 모음 (요구사항 C9, U-14, U-22, U-23).
// 정의서가 정한 값(3배·20건·20%p·70%·10건)은 그대로 두고, 정의서가 비워 둔 값은 승인받은 설계안을 따른다.
// 기준을 바꾸고 싶으면 이 파일만 고치면 된다.
export const CONFIG = Object.freeze({
  // S-08 문의 유형, R-09 기기
  CATEGORIES: Object.freeze(["쿠폰·할인", "사이즈·교환", "반품·환불", "로그인·계정", "배송", "적립금·포인트", "기타"]),
  DEVICES: Object.freeze(["iOS", "Android", "Web"]),

  // ---- 평소 기준 (U-14, 승인): 과거 이력이 이만큼 쌓이기 전에는 "평소"를 알 수 없어 판단하지 않는다
  HISTORY_MIN_DAYS: 3,

  // ---- 문의 급증 (C9): 유형별로, 한 시간 건수가 "같은 시각 과거 평균의 3배 이상"이면서 20건 이상
  SURGE_RATIO: 3,
  SURGE_MIN_COUNT: 20,
  SURGE_AVG_FLOOR: 1, // 평균이 1건 미만이면 1건으로 보고 배수를 계산 (평균 0건일 때 배수가 무한대가 되지 않게)
  // 심각도 (U-22, 승인): 배수 3~5 낮음 / 5~10 중간 / 10 이상 높음
  SURGE_RATIO_MEDIUM: 5,
  SURGE_RATIO_HIGH: 10,

  // ---- 유형 쏠림 (C9): 한 시간 동안 한 유형의 비율이 "그 이전 전체 비율"보다 20%p 이상 높음
  CATEGORY_DIFF: 0.2,
  CATEGORY_MIN_COUNT: 20, // 정의서에 없는 보호장치(승인): 그 한 시간의 전체 문의가 이만큼 되어야 비율을 믿을 수 있다
  // 심각도: +20~30%p 낮음 / 30~40 중간 / 40 이상 높음
  CATEGORY_DIFF_MEDIUM: 0.3,
  CATEGORY_DIFF_HIGH: 0.4,

  // ---- 기기·버전 쏠림 (C9): 유형별 한 시간 구간에서 한 기기 또는 앱 버전이 70% 이상이면서 20건 이상
  ENV_SHARE: 0.7,
  ENV_MIN_COUNT: 20,
  // 심각도: 70~80% 낮음 / 80~90 중간 / 90 이상 높음
  ENV_SHARE_MEDIUM: 0.8,
  ENV_SHARE_HIGH: 0.9,

  // ---- 반복 문구 (C9): 같은 문구가 한 시간 안에 10건 이상. 문장 단위로 비교하고 숫자는 #으로 가린다 (승인)
  REPEAT_MIN_COUNT: 10,
  REPEAT_MIN_PHRASE_LEN: 8, // 정규화한 문장이 이보다 짧으면("감사합니다") 반복돼도 이상으로 보지 않는다
  // 심각도: 한 시간 반복 10~19건 낮음 / 20~39 중간 / 40건 이상 높음
  REPEAT_MEDIUM: 20,
  REPEAT_HIGH: 40,

  // ---- 화면 (U-23)
  PAGE_SIZE: 5, // 근거 문의 한 페이지의 건수
  CHART_PAD_BEFORE: 36, // 급증·반복 차트에서 발생 구간 앞뒤로 함께 보여줄 시간
  CHART_PAD_AFTER: 12,

  // 기간 필터: 데이터에서 가장 최근 시각(시 단위)을 기준으로 "최근 N시간". hours: null = 전체
  PERIODS: Object.freeze([
    Object.freeze({ value: "all", label: "전체 기간", hours: null }),
    Object.freeze({ value: "24h", label: "최근 24시간", hours: 24 }),
    Object.freeze({ value: "3d", label: "최근 3일", hours: 72 }),
    Object.freeze({ value: "7d", label: "최근 7일", hours: 168 }),
  ]),
});
