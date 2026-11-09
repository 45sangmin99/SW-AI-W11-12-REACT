// 새 리뷰 입력 검증 (F-01, U-24). 순수 함수.
import { CONFIG } from "./config.js";

/**
 * @param input { product: string, rating: string|number, text: string }
 * @param knownProducts 존재하는 상품 ID 집합(Set)
 * @returns { ok: true, value } | { ok: false, errors: { product?, rating?, text? } }
 */
export function validateReview({ product = "", rating = "", text = "" } = {}, knownProducts) {
  const errors = {};

  const productId = String(product).trim();
  if (!productId) errors.product = "상품을 입력해 주세요.";
  else if (!knownProducts.has(productId)) errors.product = `존재하지 않는 상품입니다: ${productId}`;

  const stars = typeof rating === "number" ? rating : Number(String(rating).trim());
  if (String(rating).trim() === "" || !Number.isInteger(stars) || stars < CONFIG.RATING_MIN || stars > CONFIG.RATING_MAX) {
    errors.rating = `별점은 ${CONFIG.RATING_MIN}~${CONFIG.RATING_MAX} 사이의 정수여야 합니다.`;
  }

  const body = String(text).trim();
  if (!body) errors.text = "내용을 입력해 주세요. (공백만 입력할 수 없습니다)";
  else if (body.length > CONFIG.TEXT_MAX) errors.text = `내용은 ${CONFIG.TEXT_MAX}자 이하여야 합니다. (현재 ${body.length}자)`;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { product_id: productId, rating: stars, text: body } };
}
