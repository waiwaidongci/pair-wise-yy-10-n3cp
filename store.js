/*
 * 存放层 store.js
 * 负责：localStorage 持久化、整单原子提交（失败不留半截）、
 *       重复/并发请求幂等台账、证书编号唯一发号。
 * 页面层与判定层都不直接碰 localStorage。
 */
(function (global) {
  "use strict";

  const STORE_KEY = "zfl42Studio.v2";
  const LEGACY_KEY = "zfl42Works";

  function uid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function seedState() {
    const today = new Date().toISOString().slice(0, 10);
    const stamp = "2026-09-23 09:00";
    const works = [
      { id: uid(), base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 70, dryDate: today, gold: "未处理", defect: "", delivery: "2026-09-29", status: "待阴干", note: "边线需保持低浮雕感", logs: [stamp + " 创建作品"] },
      { id: uid(), base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 95, dryDate: "2026-09-20", gold: "试扫粉", defect: "左侧枝干翘线", delivery: "2026-09-26", status: "上金粉", note: "客户要求金粉偏暗", logs: [stamp + " 创建作品", stamp + " 缺陷：左侧枝干翘线"] },
      { id: uid(), base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40, dryDate: "2026-09-27", gold: "未处理", defect: "", delivery: "2026-10-02", status: "贴线中", note: "", logs: [stamp + " 创建作品"] },
      { id: uid(), base: "脱胎观音瓶", theme: "柳枝观音", line: "细线", progress: 100, dryDate: "2026-09-18", gold: "已上金粉", defect: "", delivery: "2026-09-25", status: "待交付", note: "精品柜陈列", logs: [stamp + " 创建作品"] },
      { id: uid(), base: "木胎茶盘", theme: "岁寒三友", line: "混合线", progress: 100, dryDate: "2026-09-19", gold: "已上金粉", defect: "", delivery: "2026-09-28", status: "待交付", note: "", logs: [stamp + " 创建作品"] }
    ];
    const bottle = works[3];
    const tray = works[4];
    const gradings = [
      {
        id: uid(), workId: bottle.id, state: "已签发", origin: "申请",
        grade: "珍品", inspector: "林砚秋", issuer: "周广业",
        createdAt: stamp, decidedAt: stamp, certificateId: "QXD-2026-0001",
        closedAt: "", reason: "",
        snapshot: { base: bottle.base, theme: bottle.theme, line: bottle.line, defect: "", progress: 100, gold: bottle.gold }
      },
      {
        id: uid(), workId: tray.id, state: "定级中", origin: "申请",
        grade: "", inspector: "", issuer: "",
        createdAt: stamp, decidedAt: "", certificateId: null,
        closedAt: "", reason: "",
        snapshot: { base: tray.base, theme: tray.theme, line: tray.line, defect: "", progress: 100, gold: tray.gold }
      }
    ];
    const certificates = [
      {
        number: "QXD-2026-0001", workId: bottle.id, gradingId: gradings[0].id,
        grade: "珍品", inspector: "林砚秋", issuer: "周广业",
        issuedAt: stamp, state: "有效", voidedAt: "", reason: "",
        snapshot: { base: bottle.base, theme: bottle.theme, line: bottle.line, defect: "", progress: 100, gold: bottle.gold }
      }
    ];
    bottle.logs.push(stamp + " 定级 珍品：检验 林砚秋 / 签发 周广业，证书 QXD-2026-0001 已发放");
    tray.logs.push(stamp + " 提交定级申请，进入证书队列");
    return { version: 2, works, gradings, certificates, certSeq: 1, requests: {} };
  }

  /* 旧版 zfl42Works（仅作品数组）一次性迁移，刷新后仍与新台账共处一份状态 */
  function migrateLegacy() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); } catch (_) { raw = null; }
    if (!Array.isArray(raw) || !raw.length) return null;
    const stamp = new Date().toLocaleString();
    const works = raw.map(w => ({
      id: w.id || uid(),
      base: String(w.base || ""),
      theme: String(w.theme || ""),
      line: String(w.line || "中线"),
      progress: Number(w.progress) || 0,
      dryDate: String(w.dryDate || ""),
      gold: String(w.gold || "未处理"),
      defect: String(w.defect || ""),
      delivery: String(w.delivery || ""),
      status: String(w.status || "贴线中"),
      note: String(w.note || ""),
      logs: Array.isArray(w.logs) && w.logs.length ? w.logs.map(String) : [stamp + " 迁移历史作品"]
    }));
    return { version: 2, works, gradings: [], certificates: [], certSeq: 0, requests: {} };
  }

  let cache = null;

  function normalize(state) {
    state.version = 2;
    state.works = Array.isArray(state.works) ? state.works : [];
    state.gradings = Array.isArray(state.gradings) ? state.gradings : [];
    state.certificates = Array.isArray(state.certificates) ? state.certificates : [];
    state.certSeq = Number(state.certSeq) || 0;
    state.requests = state.requests && typeof state.requests === "object" ? state.requests : {};
    return state;
  }

  function load() {
    if (cache) return cache;
    let state = null;
    try { state = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (_) { state = null; }
    if (!state) state = migrateLegacy() || seedState();
    cache = normalize(state);
    return cache;
  }

  /* 丢弃内存缓存，下次读取重新落向 localStorage（页面刷新/跨标签同步语义） */
  function resetCache() {
    cache = null;
  }

  function persist(state) {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    cache = state;
    return state;
  }

  /*
   * 原子提交：先在整份状态的深拷贝上执行 mutator，
   * mutator 抛错则整单拒绝、完全不落盘；正常返回才一次写入。
   */
  function commit(mutator) {
    const draft = clone(load());
    const result = mutator(draft);
    persist(draft);
    return result;
  }

  /*
   * 幂等请求：同一 requestKey 的重复/并发调用不再执行业务，
   * 直接沿用首次结果；只有成功提交才登记台账（失败后允许重试）。
   * valid(record, draft) 返回 false 时，旧记录视为已失效，重新执行业务并覆盖登记。
   */
  function request(requestKey, mutator, valid) {
    return commit(function (draft) {
      const prior = requestKey ? draft.requests[requestKey] : null;
      if (prior && (!valid || valid(prior, draft))) {
        return Object.assign({ reused: true }, prior);
      }
      const out = mutator(draft) || {};
      if (requestKey) {
        draft.requests[requestKey] = { type: out.type || "", id: out.id || "", at: new Date().toISOString() };
      }
      return Object.assign({ reused: false }, out);
    });
  }

  /* 证书编号：年内自增序号 + 全台账去重，保证唯一 */
  function nextCertificateNumber(draft) {
    const prefix = "QXD-" + new Date().getFullYear() + "-";
    let number;
    do {
      draft.certSeq = (Number(draft.certSeq) || 0) + 1;
      number = prefix + String(draft.certSeq).padStart(4, "0");
    } while (draft.certificates.some(c => c.number === number));
    return number;
  }

  global.Store = { load, commit, request, uid, nextCertificateNumber, resetCache };
})(window);
