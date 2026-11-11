// 고객 문의(VOC) 이상 탐지 페이지 진입점
import { mountApp } from "./app.js";

mountApp(document.getElementById("app"), { dataUrl: "data/inquiries.sample.json" });
