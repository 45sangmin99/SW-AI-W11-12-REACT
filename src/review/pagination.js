// 페이지 나누기 (F-02, 순수 함수)

/**
 * @returns { items, page, totalPages, total }
 *   page는 항상 1~totalPages로 보정된다. 필터로 건수가 줄어 예전 페이지 번호가 범위를 벗어나도 안전하다
 */
export function paginate(items, page, size) {
  const total = items.length;
  const pageSize = Number.isInteger(size) && size > 0 ? size : 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const wanted = Number.isInteger(page) ? page : 1;
  const current = Math.min(Math.max(wanted, 1), totalPages);
  return { items: items.slice((current - 1) * pageSize, current * pageSize), page: current, totalPages, total };
}

/**
 * 화면에 그릴 페이지 번호 목록. 첫·끝 페이지와 현재 페이지 앞뒤 한 칸만 보이고 나머지는 "…"로 줄인다.
 * 예: page=5, total=10 -> [1, "…", 4, 5, 6, "…", 10]
 */
export function pageWindow(page, totalPages) {
  const keep = new Set([1, totalPages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= totalPages));
  const sorted = [...keep].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push("…");
    out.push(n);
  });
  return out;
}
