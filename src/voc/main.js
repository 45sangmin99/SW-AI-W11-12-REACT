// 고객 문의(VOC) 이상 탐지 페이지 진입점
import { mountApp } from "./app.js";

// 기본은 중계기(tools/dev-proxy.py)를 거쳐 Mini DBMS에서 읽는다.
// 주소 뒤에 ?source=sample 을 붙이면 DB 없이 예전처럼 샘플 JSON을 읽는다 (DB가 꺼져 있을 때 쓰는 비상 수단)
const useSample = new URLSearchParams(location.search).get("source") === "sample";
mountApp(document.getElementById("app"), { dataUrl: useSample ? "data/inquiries.sample.json" : "api/inquiries" });
