#!/usr/bin/env node
// VOC 서비스 API (Step 4). 화면 파일과 /api/v1/* 를 같은 주소에서 제공한다.
//
//   브라우저(Mini React) ──/api/v1/*──▶ 이 서비스 ──SQL + Bearer 토큰──▶ Mini DBMS (원본)
//                                          └─────HTTP 캐시────────────▶ Mini Redis (선택)
//
// - 필터·탐지·집계·근거 페이지 계산은 여기서 한다. 탐지 코드는 브라우저 샘플 모드와 같은 src/voc/analysis.js 한 벌이다.
// - DBMS 토큰과 SQL은 이 서비스만 안다. 브라우저는 SQL을 보낼 수 없다.
// - Redis는 없어도 된다. 연결 실패·키 없음·값 한도·압축 해제 실패는 모두 캐시 miss로 보고 DBMS로 응답한다.
// - 서비스는 한 인스턴스만 지원한다 (세대 번호와 중복 방지가 이 프로세스 안에서만 유효하다). 두 번째 실행은 거부한다.
//
// 열어 두는 주소
//   GET  /api/v1/overview                     합계·최다 유형·앱 버전 목록
//   GET  /api/v1/alerts                       이상 신호 카드 목록 (상태 포함)
//   GET  /api/v1/alerts/{id}                  신호 상세: 이유·차트·근거 문의 한 페이지
//   GET  /api/v1/alerts/{id}/status-history   진행 상태 이력
//   POST /api/v1/alerts/{id}/status           상태 추가 { status } -> 201 { alertId, status, at }
//   POST /api/v1/admin/invalidate             문의를 다시 적재한 뒤 캐시를 비운다 (헤더 X-Admin-Token 필요)
//   공통 조회 조건: period, category, device, appVersion, query. 조회 응답의 dataSource는 "redis" 또는 "dbms"
//
// 저장 결과 (POST status)
//   201  DBMS가 영구 저장(DURABLE)을 확인했다
//   409  다른 쓰기와 충돌해 저장되지 않았다 (outcome: "not_saved"). 3번까지 다시 시도한 뒤의 결과다
//   502  저장되지 않았거나(not_saved) 저장 여부를 알 수 없다(unknown)
//   503  DBMS에 닿지 못했다
//   "unknown"은 다시 보내면 중복 저장될 수 있으므로 자동으로 다시 시도하지 않는다.
//
// 실행: ./tools/start-all.sh (또는 MINIDB_TOKEN=... node tools/voc-service.mjs). 127.0.0.1에서만 받는다.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { CONFIG } from "../src/voc/config.js";
import { parseDataset } from "../src/voc/data.js";
import { currentStatus } from "../src/voc/status.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  QueryError,
  analyze,
  cardsOf,
  detailOf,
  filterKey,
  intParam,
  listPage,
  normalizeFilters,
  normalizeStatusFilter,
  overviewOf,
} from "../src/voc/query.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = 10000; // DBMS가 한 번에 돌려주는 최대 행 수
const MAX_BODY = 4096;
const ALERT_ID_MAX = 120; // db/alert_status_history.schema 의 alert_id 한도 (바이트)
const CONFLICT_RETRIES = 3;
const BLOCKED = ["/.git", "/dbms", "/db/data", "/tools", "/redis", "/node_modules"]; // 화면 파일로 내보내지 않는 경로
// 지금 DB에는 시연용으로 만든 샘플만 들어 있으므로 시연 데이터 표시를 켠다. 실제 문의를 넣게 되면 false로 바꾼다
const META = { generated: true, source: "mini-dbms" };
const TTL_ANALYSIS = 60; // 초. 분석 결과 (문의가 바뀌면 세대 번호가 올라가서 옛 키는 더 이상 조회되지 않는다)
const TTL_STATUSES = 10; // 초. 상태 이력
const CACHE_PREFIX = "z:"; // 압축 저장 형식 표시 (zlib + base64). 이 표시가 없는 값은 없는 것으로 본다
const CACHE_VALUE_MAX = 900_000; // Mini Redis 값 한도(1MiB)보다 작게. 넘으면 캐시하지 않는다

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".md": "text/plain; charset=utf-8",
};

// ---------------------------------------------------------------- 오류
class DbError extends Error {
  /** maybeSaved: 쓰기 요청이 이미 전달됐을 수 있으면 true */
  constructor(message, maybeSaved = false) {
    super(message);
    this.maybeSaved = maybeSaved;
  }
}
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------- 한 인스턴스만 (잠금 파일)
function acquireInstanceLock() {
  // 잠금 파일 위치는 시험에서 서비스를 따로 띄울 때만 VOC_SERVICE_LOCK으로 바꾼다
  const file = process.env.VOC_SERVICE_LOCK ?? path.join(os.tmpdir(), "mini-react-voc-service.lock");
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      const release = () => {
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file);
        } catch {
          /* 이미 지워졌다 */
        }
      };
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const other = Number(fs.readFileSync(file, "utf8"));
      if (other && alive(other)) {
        console.error(`오류: VOC 서비스가 이미 실행 중입니다 (pid ${other}). 서비스는 한 인스턴스만 지원합니다.`);
        process.exit(1);
      }
      fs.unlinkSync(file); // 비정상 종료로 남은 잠금이다
    }
  }
  console.error("오류: 잠금 파일을 만들지 못했습니다");
  process.exit(1);
}

// ---------------------------------------------------------------- DBMS 클라이언트
class Db {
  constructor(url, token) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  /** SQL 한 문장을 실행하고 { status, data }를 돌려준다 */
  async query(sql) {
    let res;
    try {
      res = await fetch(`${this.url}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      // 연결 자체가 거절됐으면 전달되지 않은 것이다. 그 밖에는 전달됐을 수 있다
      const refused = e?.cause?.code === "ECONNREFUSED";
      throw new DbError(refused ? "DBMS 서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인해 주세요." : "DBMS 서버의 응답을 받지 못했습니다.", !refused);
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* 본문이 JSON이 아니면 빈 객체 */
    }
    return { status: res.status, data };
  }

  /** id 순서로 전부 읽는다. 한 번에 10,000행까지만 받을 수 있어 id 기준으로 나눠 읽는다 */
  async selectAll(columns, table) {
    const rows = [];
    let last = 0;
    for (;;) {
      const { status, data } = await this.query(`SELECT id,${columns} FROM ${table} WHERE id>${last} ORDER BY id LIMIT ${PAGE};`);
      if (status !== 200 || !data.ok) throw new DbError(`DBMS 조회에 실패했습니다: ${data.error?.message ?? `HTTP ${status}`}`);
      for (const row of data.rows) rows.push(row);
      if (data.rows.length < PAGE) return rows;
      last = Number(data.rows[data.rows.length - 1][0]);
    }
  }
}

const sqlQuote = (value) => `'${value.replaceAll("'", "''")}'`;

// ---------------------------------------------------------------- Redis(HTTP) 캐시
class Cache {
  constructor(url) {
    this.url = url.replace(/\/$/, "");
  }
  keyUrl(key) {
    return `${this.url}/keys/${encodeURIComponent(key)}`;
  }

  /** 저장된 문자열. 없거나 Redis에 문제가 있거나 형식이 다르면 undefined (모두 miss) */
  async get(key) {
    try {
      const res = await fetch(this.keyUrl(key), { signal: AbortSignal.timeout(2000) });
      if (res.status !== 200) {
        await res.arrayBuffer().catch(() => {});
        return undefined;
      }
      const { value } = await res.json();
      if (typeof value !== "string" || !value.startsWith(CACHE_PREFIX)) return undefined;
      return zlib.inflateSync(Buffer.from(value.slice(CACHE_PREFIX.length), "base64")).toString("utf8");
    } catch {
      return undefined;
    }
  }

  /** 압축해서 저장한다. 한도를 넘거나 실패해도 조용히 넘어간다 (이번 응답은 이미 DBMS에서 읽은 값이다) */
  async put(key, text, ttl) {
    try {
      const packed = CACHE_PREFIX + zlib.deflateSync(Buffer.from(text, "utf8"), { level: 6 }).toString("base64");
      if (packed.length > CACHE_VALUE_MAX) return false;
      const res = await fetch(this.keyUrl(key), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: packed, ttl_seconds: ttl }),
        signal: AbortSignal.timeout(2000),
      });
      await res.arrayBuffer().catch(() => {});
      return res.status === 204;
    } catch {
      return false;
    }
  }

  async delete(key) {
    try {
      const res = await fetch(this.keyUrl(key), { method: "DELETE", signal: AbortSignal.timeout(2000) });
      await res.arrayBuffer().catch(() => {});
      return true;
    } catch {
      return false; // TTL이 지나면 사라진다
    }
  }
}

// ---------------------------------------------------------------- 세대 번호 (캐시 무효화)
// 키에 세대 번호를 넣고, 무효화하면 번호를 올린다. 옛 키는 아무도 조회하지 않고 TTL로 사라진다 (키를 훑는 삭제가 필요 없다).
// 시작 시각을 번호에 넣어서, 서버를 다시 켜도 Redis(AOF)에 남은 옛 키와 번호가 겹치지 않는다.
const bootToken = Date.now().toString(36);
const generation = { inquiry: `${bootToken}.0`, status: `${bootToken}.0` };
let generationSeq = 0;
const bump = (name) => (generation[name] = `${bootToken}.${++generationSeq}`);

// ---------------------------------------------------------------- 서비스 본체
function createService({ db, cache }) {
  const flights = new Map(); // 키별로 진행 중인 계산. 같은 키의 동시 miss를 DBMS 조회 한 번으로 합친다
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

  /**
   * 캐시 어사이드. { value, source }를 돌려준다. source는 "redis" 또는 "dbms".
   * 계산하는 사이 세대가 바뀌었으면(= 읽는 도중 무효화) 결과는 이번 요청에만 돌려주고 Redis에는 저장하지 않는다.
   */
  async function cached(key, ttl, genName, build) {
    const hit = await cache.get(key);
    if (hit !== undefined) {
      try {
        return { value: JSON.parse(hit), source: "redis" };
      } catch {
        /* 깨진 값은 miss로 본다 */
      }
    }
    if (flights.has(key)) return flights.get(key);
    const startedAt = generation[genName];
    const flight = (async () => {
      const value = await build();
      if (generation[genName] === startedAt) await cache.put(key, JSON.stringify(value), ttl);
      return { value, source: "dbms" };
    })().finally(() => flights.delete(key));
    flights.set(key, flight);
    return flight;
  }

  const analysisKey = (kind, ...parts) => `cache:voc:v1:analysis:${generation.inquiry}:${sha([kind, ...parts].join("|"))}`;

  async function loadInquiries() {
    const columns = ["created_at", "category", "device", "app_version", "text"];
    const rows = await db.selectAll(columns.join(","), "inquiries");
    const objects = rows.map((r) => ({ id: Number(r[0]), ...Object.fromEntries(columns.map((c, i) => [c, r[i + 1]])) }));
    return parseDataset(objects).inquiries; // 형식이 틀린 행은 건너뛴다 (R-09)
  }

  async function loadStatusMap() {
    const map = {};
    for (const [, alertId, status, at] of await db.selectAll("alert_id,status,at", "alert_status_history")) (map[alertId] ??= []).push({ status, at });
    return map;
  }

  const statusMap = () => cached(`cache:voc:v1:statuses:${generation.status}`, TTL_STATUSES, "status", loadStatusMap);

  return {
    async overview(filters) {
      const { value, source } = await cached(analysisKey("overview", filterKey(filters)), TTL_ANALYSIS, "inquiry", async () => ({
        meta: META,
        ...overviewOf(analyze(await loadInquiries(), filters)),
      }));
      return { ...value, dataSource: source };
    },

    async alerts(filters, { status, page, pageSize }) {
      const [{ value: cards, source }, { value: statuses }] = await Promise.all([
        cached(analysisKey("cards", filterKey(filters)), TTL_ANALYSIS, "inquiry", async () => cardsOf(analyze(await loadInquiries(), filters))),
        statusMap(),
      ]);
      return { ...listPage(cards, statuses, { status, page, pageSize }), dataSource: source };
    },

    async detail(filters, id, evidencePage) {
      const [{ value, source }, { value: statuses }] = await Promise.all([
        cached(analysisKey("detail", filterKey(filters), id, evidencePage), TTL_ANALYSIS, "inquiry", async () => {
          const found = detailOf(analyze(await loadInquiries(), filters), id, evidencePage);
          if (!found) throw new HttpError(404, "현재 조건에서 찾을 수 없는 이상 신호입니다");
          return found;
        }),
        statusMap(),
      ]);
      return { ...value, alert: { ...value.alert, currentStatus: currentStatus(statuses[id]) }, dataSource: source };
    },

    async history(id) {
      const { value: statuses, source } = await statusMap();
      const history = statuses[id] ?? [];
      return { alertId: id, currentStatus: currentStatus(history), history, dataSource: source };
    },

    async saveStatus(alertId, status) {
      const at = new Date().toISOString(); // 시각은 이 서비스가 찍는다 (UTC, 밀리초)
      const sql = `INSERT INTO alert_status_history (alert_id,status,at) VALUES (${sqlQuote(alertId)},${sqlQuote(status)},${sqlQuote(at)});`;
      let result;
      try {
        for (let attempt = 0; ; attempt++) {
          result = await db.query(sql);
          if (result.status === 409 && attempt < CONFLICT_RETRIES) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
            continue; // 충돌은 확정 전에 거절된 것이라 다시 보내도 중복 저장이 없다
          }
          break;
        }
      } catch (e) {
        if (e instanceof DbError && e.maybeSaved) await this.invalidateStatuses(); // 저장됐을 수 있으니 옛 캐시를 남기지 않는다
        if (e instanceof DbError) throw new HttpError(503, e.message, { outcome: e.maybeSaved ? "unknown" : "not_saved" });
        throw e;
      }
      const { status: code, data } = result;
      if (code === 200 && data.ok && data.commit === "DURABLE") {
        await this.invalidateStatuses(); // DBMS 저장이 확인된 뒤에 지운다 (반대 순서 금지)
        return { alertId, status, at };
      }
      const unknown = data.commit === "UNKNOWN" || Boolean(data.recovery_required);
      if (unknown) await this.invalidateStatuses();
      if (code === 409) throw new HttpError(409, "다른 변경과 충돌해 저장하지 못했습니다. 다시 시도해 주세요.", { outcome: "not_saved" });
      throw new HttpError(502, `저장하지 못했습니다: ${data.error?.message ?? `HTTP ${code}`}`, { outcome: unknown ? "unknown" : "not_saved" });
    },

    /** 상태 저장 뒤: 세대를 올린 다음 옛 키를 지운다 */
    async invalidateStatuses() {
      const oldKey = `cache:voc:v1:statuses:${generation.status}`;
      bump("status");
      await cache.delete(oldKey);
    },

    /** 문의를 다시 적재한 뒤: 분석 캐시의 세대를 올린다. 옛 키는 TTL로 사라진다 */
    invalidateAll() {
      bump("inquiry");
      bump("status");
      return { ...generation };
    },
  };
}

// ---------------------------------------------------------------- HTTP
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store", ...extraHeaders });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(400, "요청 본문의 크기가 올바르지 않습니다.");
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, "요청 본문이 필요합니다.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "요청 본문이 올바른 JSON이 아닙니다.");
  }
}

function validAlertId(id) {
  return typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= ALERT_ID_MAX && ![...id].some((ch) => ch.charCodeAt(0) < 32);
}

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(404, "없는 주소입니다.");
  }
  if (BLOCKED.some((b) => decoded === b || decoded.startsWith(`${b}/`))) throw new HttpError(404, "없는 주소입니다.");
  let file = path.join(ROOT, decoded);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) throw new HttpError(404, "없는 주소입니다.");
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, "없는 주소입니다.");
  const body = fs.readFileSync(file);
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : body);
}

function createServer(service) {
  const ADMIN_TOKEN = Buffer.from(process.env.MINIDB_TOKEN);

  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;
    const q = Object.fromEntries(url.searchParams);
    const source = (body) => ({ "X-Data-Source": body.dataSource });

    if (!pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "허용되지 않는 방법입니다.");
      return serveStatic(req, res, pathname);
    }
    if (!pathname.startsWith("/api/v1/")) throw new HttpError(404, "없는 주소입니다.");
    const parts = pathname.slice("/api/v1/".length).split("/").map(decodeURIComponent);

    if (req.method === "GET") {
      if (parts[0] === "overview" && parts.length === 1) {
        const body = await service.overview(normalizeFilters(q));
        return sendJson(res, 200, body, source(body));
      }
      if (parts[0] === "alerts" && parts.length === 1) {
        const body = await service.alerts(normalizeFilters(q), {
          status: normalizeStatusFilter(q.status),
          page: intParam(q.page, "page", 1, 1, 1_000_000),
          pageSize: intParam(q.pageSize, "pageSize", DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
        });
        return sendJson(res, 200, body, source(body));
      }
      if (parts[0] === "alerts" && parts.length === 2) {
        const body = await service.detail(normalizeFilters(q), parts[1], intParam(q.evidencePage, "evidencePage", 1, 1, 1_000_000));
        return sendJson(res, 200, body, source(body));
      }
      if (parts[0] === "alerts" && parts.length === 3 && parts[2] === "status-history") {
        if (!validAlertId(parts[1])) throw new HttpError(400, "alertId가 올바르지 않습니다.");
        const body = await service.history(parts[1]);
        return sendJson(res, 200, body, source(body));
      }
      throw new HttpError(404, "없는 주소입니다.");
    }

    if (req.method === "POST") {
      if (parts[0] === "alerts" && parts.length === 3 && parts[2] === "status") {
        const alertId = parts[1];
        if (!validAlertId(alertId)) throw new HttpError(400, "alertId가 올바르지 않습니다.");
        const body = await readJsonBody(req);
        if (typeof body?.status !== "string" || !CONFIG.STATUSES.includes(body.status)) throw new HttpError(400, `알 수 없는 상태입니다: ${body?.status}`);
        return sendJson(res, 201, await service.saveStatus(alertId, body.status));
      }
      if (parts[0] === "admin" && parts[1] === "invalidate" && parts.length === 2) {
        const given = Buffer.from(String(req.headers["x-admin-token"] ?? ""));
        if (given.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(given, ADMIN_TOKEN)) throw new HttpError(401, "관리 토큰이 필요합니다.");
        return sendJson(res, 200, service.invalidateAll());
      }
      throw new HttpError(404, "없는 주소입니다.");
    }
    throw new HttpError(405, "허용되지 않는 방법입니다.");
  }

  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e instanceof QueryError) return sendJson(res, 400, { error: e.message });
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof DbError) return sendJson(res, 503, { error: e.message });
      console.error(e);
      sendJson(res, 500, { error: "서비스에서 오류가 났습니다." });
    });
  });
}

// ---------------------------------------------------------------- 시작
function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const token = process.env.MINIDB_TOKEN;
  if (!token) {
    console.error("오류: 환경변수 MINIDB_TOKEN 이 필요합니다. DBMS 서버를 켤 때 쓴 것과 같은 값을 넣으세요");
    process.exit(1);
  }
  const port = Number(option("port", "8001"));
  const dbUrl = option("db-url", process.env.MINIDB_URL ?? "http://127.0.0.1:8080");
  const redisUrl = option("redis-url", process.env.MINIREDIS_URL ?? "http://127.0.0.1:6380");
  acquireInstanceLock();

  const service = createService({ db: new Db(dbUrl, token), cache: new Cache(redisUrl) });
  const server = createServer(service);
  server.on("error", (e) => {
    console.error(`오류: 포트 ${port}를 열지 못했습니다 (${e.code ?? e.message})`);
    process.exit(1);
  });

  const reachable = async (url) => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      return false;
    }
  };
  const dbState = (await reachable(`${dbUrl.replace(/\/$/, "")}/health`)) ? "연결됨" : "연결 안 됨 (DBMS 서버를 먼저 켜세요)";
  const redisState = (await reachable(`${redisUrl.replace(/\/$/, "")}/keys/ping`)) ? "연결됨" : "연결 안 됨 (캐시 없이 DBMS로만 동작)";
  server.listen(port, "127.0.0.1", () => {
    console.log(`VOC 서비스: http://localhost:${port}/voc.html  |  DBMS ${dbUrl}: ${dbState}  |  Redis ${redisUrl}: ${redisState}`);
  });
}

main();
