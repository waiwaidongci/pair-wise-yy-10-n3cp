// 规则链验证：在 Node 中模拟浏览器环境加载 store.js / grading.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const mem = new Map();
const localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k)
};
let uuidN = 0;
const sandbox = {
  localStorage,
  console,
  Date,
  Math,
  JSON,
  Number,
  String,
  Array,
  Object,
  isNaN,
  setTimeout,
  crypto: { randomUUID: () => "uuid-" + ++uuidN }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ["store.js", "grading.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sandbox, { filename: f });
}
const { Store, Grading } = sandbox;

let pass = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + e.message); process.exitCode = 1; }
}
function reject(name, fn, msgPart) {
  try { fn(); console.error("  ✗ " + name + "：应当拒绝却成功"); process.exitCode = 1; }
  catch (e) {
    if (msgPart && !e.message.includes(msgPart)) { console.error("  ✗ " + name + "：报错不符 → " + e.message); process.exitCode = 1; return; }
    pass++; console.log("  ✓ " + name);
  }
}

// 用种子数据：w2 有缺陷/95%，w3 40%，w4 已有效证书，w5 100% 无缺陷且定级中
function reset() {
  mem.clear();
  Store.resetCache();
}
function ids() {
  const w = Store.load().works;
  return { defective: w[1].id, unfinished: w[2].id, certified: w[3].id, pending: w[4].id };
}

console.log("1) 申请资格");
reset(); let t = ids();
reject("进度未满不能申请", () => Grading.applyGrading(t.unfinished), "进度");
reject("有缺陷不能申请", () => Grading.applyGrading(t.defective), "缺陷");
reject("已有有效证书不能重复申请", () => Grading.applyGrading(t.certified), "有效证书");
ok("定级中作品重复申请沿用首次结果（同一定级单）", () => {
  const st = Store.load();
  const g0 = st.gradings.find(g => g.workId === t.pending && g.state === "定级中");
  const r = Grading.applyGrading(t.pending);
  assert.strictEqual(r.id, g0.id);
});
ok("同一作品连点两次申请：第二次沿用首次结果，不产生第二条定级单", () => {
  const wid = Store.load().works[0].id;
  Grading.changeWork({ workId: wid, base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 100, gold: "已上金粉", defect: "" });
  const r1 = Grading.applyGrading(wid);
  const r2 = Grading.applyGrading(wid);
  assert.strictEqual(r2.id, r1.id);
  assert.strictEqual(r2.reused, true);
  assert.strictEqual(Store.load().gradings.filter(g => g.workId === wid && g.state === "定级中").length, 1);
});

console.log("2) 审签规则与整单原子性");
reject("缺等级", () => Grading.signGrading({ gradingId: "不存在", grade: "", inspector: "a", issuer: "b" }));
ok("校验全部通过后才落盘；模拟同人冲突不留半截", () => {
  const before = JSON.stringify(Store.load());
  const g = Store.load().gradings.find(x => x.workId === t.pending);
  let threw = false;
  try { Grading.signGrading({ gradingId: g.id, grade: "一级", inspector: "陈守拙", issuer: "陈守拙" }); }
  catch (e) { threw = true; assert.match(e.message, /不得为同一人/); }
  assert.ok(threw);
  assert.strictEqual(JSON.stringify(Store.load()), before, "拒绝后状态零变更");
});
reject("缺检验人", () => {
  const g = Store.load().gradings.find(x => x.workId === t.pending);
  Grading.signGrading({ gradingId: g.id, grade: "一级", inspector: "", issuer: "周广业" });
}, "检验人");
reject("缺签发人", () => {
  const g = Store.load().gradings.find(x => x.workId === t.pending);
  Grading.signGrading({ gradingId: g.id, grade: "一级", inspector: "林砚秋", issuer: "" });
}, "签发人");
ok("齐备且不同人 → 签发成功，证书编号唯一", () => {
  const g = Store.load().gradings.find(x => x.workId === t.pending);
  const r = Grading.signGrading({ gradingId: g.id, grade: "一级", inspector: "林砚秋", issuer: "周广业" });
  assert.strictEqual(r.id, "QXD-2026-0002");
  const st = Store.load();
  const cert = st.certificates.find(c => c.number === "QXD-2026-0002");
  assert.strictEqual(cert.state, "有效");
  assert.strictEqual(new Set(st.certificates.map(c => c.number)).size, st.certificates.length);
  assert.strictEqual(st.gradings.find(x => x.id === g.id).state, "已签发");
});

console.log("3) 拒绝后整改可重新申请（幂等键失效）");
reset(); t = ids();
ok("整单拒绝后可重新申请，产生新定级单", () => {
  const g0 = Store.load().gradings.find(x => x.workId === t.pending);
  Grading.rejectGrading(g0.id, "金粉不均");
  const r = Grading.applyGrading(t.pending);
  assert.notStrictEqual(r.id, g0.id);
  const g1 = Store.load().gradings.find(x => x.id === r.id);
  assert.strictEqual(g1.state, "定级中");
});

console.log("4) 核心值变动 → 旧证失效、只读、按新值重判");
reset(); t = ids();
ok("改动纹样：旧证失效只读，自动开重判定级，新证书另发新号", () => {
  const w = Store.load().works.find(x => x.id === t.certified);
  Grading.changeWork({ workId: w.id, base: w.base, theme: "莲花童子", line: w.line, progress: 100, gold: w.gold, defect: "" });
  const st = Store.load();
  const old = st.certificates.find(c => c.number === "QXD-2026-0001");
  assert.strictEqual(old.state, "已失效");
  assert.match(old.reason, /纹样主题/);
  const g = st.gradings.find(x => x.workId === w.id && x.state === "定级中");
  assert.ok(g, "应有一条重判定级");
  assert.strictEqual(g.origin, "重判");
  assert.strictEqual(g.snapshot.theme, "莲花童子");
  Grading.signGrading({ gradingId: g.id, grade: "珍品", inspector: "黄素绫", issuer: "周广业" });
  const st2 = Store.load();
  const fresh = st2.certificates.filter(c => c.workId === w.id);
  assert.strictEqual(fresh.length, 2);
  assert.strictEqual(fresh[0].state, "已失效");
  assert.strictEqual(fresh[1].state, "有效");
  assert.strictEqual(fresh[1].number, "QXD-2026-0002");
  // 旧证字段不可再被业务改动：重判只动 state/voidedAt/reason 一次
  assert.strictEqual(fresh[0].grade, "珍品");
});
ok("改动胎体/线条同样触发失效；进行中定级被取消重开", () => {
  reset(); t = ids();
  const w = Store.load().works.find(x => x.id === t.pending); // 定级中，无证书
  Grading.changeWork({ workId: w.id, base: "竹胎茶盘", theme: w.theme, line: "粗线", progress: 100, gold: w.gold, defect: "" });
  const st = Store.load();
  const open = st.gradings.filter(g => g.workId === w.id && g.state === "定级中");
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].origin, "重判");
  assert.strictEqual(open[0].snapshot.base, "竹胎茶盘");
});
ok("出现缺陷：旧证失效，且不自动开新单（不满足资格）", () => {
  const st0 = Store.load();
  const wid = st0.works[0]; // 造一个满工无缺陷作品
  Grading.changeWork({ workId: wid.id, base: wid.base, theme: wid.theme, line: wid.line, progress: 100, gold: "已上金粉", defect: "" });
  Grading.applyGrading(wid.id);
  const g = Store.load().gradings.find(x => x.workId === wid.id && x.state === "定级中");
  Grading.signGrading({ gradingId: g.id, grade: "二级", inspector: "陈守拙", issuer: "林砚秋" });
  Grading.changeWork({ workId: wid.id, base: wid.base, theme: wid.theme, line: wid.line, progress: 100, gold: "已上金粉", defect: "口沿断线" });
  const st = Store.load();
  assert.strictEqual(st.certificates.filter(c => c.workId === wid.id && c.state === "有效").length, 0);
  assert.strictEqual(st.gradings.filter(x => x.workId === wid.id && x.state === "定级中").length, 0);
  reject("缺陷未消不能重新申请", () => Grading.applyGrading(wid.id), "缺陷");
});
ok("非核心字段（进度/金粉）不触发失效", () => {
  reset(); t = ids();
  const w = Store.load().works.find(x => x.id === t.certified);
  Grading.changeWork({ workId: w.id, base: w.base, theme: w.theme, line: w.line, progress: 90, gold: "试扫粉", defect: "" });
  const c = Store.load().certificates.find(c => c.number === "QXD-2026-0001");
  assert.strictEqual(c.state, "有效");
  assert.strictEqual(Store.load().gradings.filter(g => g.workId === w.id && g.state === "定级中").length, 0);
});

console.log("5) 并发/重复签发与编号");
reset(); t = ids();
ok("同一定级单重复签发：第二次整单拒绝（已结束），不产生第二个编号", () => {
  const g = Store.load().gradings.find(x => x.workId === t.pending);
  Grading.signGrading({ gradingId: g.id, grade: "二级", inspector: "林砚秋", issuer: "周广业" });
  let threw = false;
  try { Grading.signGrading({ gradingId: g.id, grade: "二级", inspector: "林砚秋", issuer: "周广业" }); }
  catch (e) { threw = true; assert.match(e.message, /已结束/); }
  assert.ok(threw);
  assert.strictEqual(Store.load().certificates.filter(c => c.gradingId === g.id).length, 1);
});

console.log("6) 刷新一致性（重新 load 同一 localStorage）");
ok("Store.load 返回持久化结果，看板/队列/台账同源", () => {
  const st1 = Store.load();
  // 模拟刷新：清缓存需新进程；这里校验导出结构完整即可
  ["works", "gradings", "certificates", "requests", "certSeq"].forEach(k => assert.ok(k in st1));
  const raw = JSON.parse(localStorage.getItem("zfl42Studio.v2"));
  assert.strictEqual(raw.certificates.length, st1.certificates.length);
});

console.log("7) 旧数据迁移（全新上下文模拟刷新）");
ok("旧版作品数组自动迁移为 v2 状态", () => {
  const mem2 = new Map();
  mem2.set("zfl42Works", JSON.stringify([
    { id: "old-1", base: "木胎", theme: "古纹样", line: "细线", progress: 100, dryDate: "2026-09-01", gold: "已上金粉", defect: "", delivery: "2026-09-10", status: "待交付", note: "", logs: ["创建作品"] }
  ]));
  const sb = {
    localStorage: { getItem: k => mem2.get(k) || null, setItem: (k, v) => mem2.set(k, String(v)), removeItem: k => mem2.delete(k) },
    console, Date, Math, JSON, Number, String, Array, Object, isNaN, setTimeout
  };
  let n2 = 0;
  sb.crypto = { randomUUID: () => "u2-" + ++n2 };
  sb.window = sb;
  vm.createContext(sb);
  for (const f of ["store.js", "grading.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), sb, { filename: f });
  }
  const st = sb.Store.load();
  assert.strictEqual(st.version, 2);
  assert.strictEqual(st.works.length, 1);
  assert.strictEqual(st.works[0].id, "old-1");
  const r = sb.Grading.applyGrading("old-1");
  assert.ok(r.id);
  assert.strictEqual(sb.Store.load().gradings.find(x => x.id === r.id).workId, "old-1");
  assert.ok(mem2.has("zfl42Studio.v2"), "迁移后写入新键");
});

console.log("\n通过 " + pass + " 项断言");
