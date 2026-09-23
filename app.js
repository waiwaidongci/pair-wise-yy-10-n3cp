/* 页面：看板、证书队列与作品履历的渲染和交互，规则走 Grading，持久化走 Store */
const statuses = ["贴线中", "待阴干", "上金粉", "待交付"];
const today = new Date().toISOString().slice(0, 10);
const seed = [
  { id: crypto.randomUUID(), base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 70, dryDate: today, gold: "未处理", defect: "", delivery: "2026-06-26", status: "待阴干", note: "边线需保持低浮雕感", logs: ["创建作品"] },
  { id: crypto.randomUUID(), base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 95, dryDate: "2026-06-20", gold: "试扫粉", defect: "左侧枝干翘线", delivery: "2026-06-23", status: "上金粉", note: "客户要求金粉偏暗", logs: ["创建作品", "记录翘线"] },
  { id: crypto.randomUUID(), base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40, dryDate: "2026-06-24", gold: "未处理", defect: "", delivery: "2026-06-30", status: "贴线中", note: "", logs: ["创建作品"] },
  { id: crypto.randomUUID(), base: "脱胎花瓶", theme: "龙凤呈祥", line: "细线", progress: 100, dryDate: "2026-06-18", gold: "已上金粉", defect: "", delivery: "2026-06-25", status: "待交付", note: "馆藏级订单，可申请定级", logs: ["创建作品", "贴线完成"] }
];

const state = Store.load(seed);
const works = state.works;
let activeId = null;

const form = document.querySelector("#workForm");
const board = document.querySelector("#board");
const statusFilter = document.querySelector("#statusFilter");
const themeFilter = document.querySelector("#themeFilter");
const sortMode = document.querySelector("#sortMode");
const dialog = document.querySelector("#detailDialog");

form.dryDate.value = today;
form.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
statusFilter.innerHTML = `<option value="">全部状态</option>` + statuses.map(s => `<option>${s}</option>`).join("");

function save() {
  Store.save(state);
}

function workOf(id) {
  return works.find(w => w.id === id);
}

function validCertOf(workId) {
  return state.certificates.find(c => c.workId === workId && c.status === "有效") || null;
}

function filtered() {
  return works
    .filter(w => !statusFilter.value || w.status === statusFilter.value)
    .filter(w => !themeFilter.value || w.theme.includes(themeFilter.value.trim()))
    .sort((a, b) => (a[sortMode.value] || "").localeCompare(b[sortMode.value] || ""));
}

function updateStatus(id, status) {
  const work = workOf(id);
  work.status = status;
  if (status === "待阴干") work.dryDate = new Date().toISOString().slice(0, 10);
  if (status === "上金粉") work.gold = "已上金粉";
  if (status === "待交付") work.progress = 100;
  work.logs.push(`${new Date().toLocaleString()} 更新为 ${status}`);
  save();
  render();
}

function recordDefect(id, text) {
  const work = workOf(id);
  const value = text || prompt("输入断线/翘线位置");
  if (!value) return;
  work.defect = work.defect ? `${work.defect}; ${value}` : value;
  work.logs.push(`${new Date().toLocaleString()} 缺陷：${value}`);
  Grading.revalidate(state, id, ["defect"]);
  save();
  render();
}

function applyGrading(id) {
  const result = Grading.apply(state, id);
  if (!result.ok) {
    alert(`不能申请定级：${result.error}`);
    return;
  }
  save();
  render();
}

function completeReview(applicationId) {
  const result = Grading.complete(state, applicationId, {
    grade: document.querySelector(`#grade-${applicationId}`).value,
    inspector: document.querySelector(`#insp-${applicationId}`).value,
    signer: document.querySelector(`#sign-${applicationId}`).value
  });
  if (!result.ok && !result.reused) alert(`整单拒绝：${result.error}`);
  save();
  render();
}

function showDetail(id) {
  activeId = id;
  const w = workOf(id);
  document.querySelector("#detailTitle").textContent = `${w.theme} · ${w.base}`;
  document.querySelector("#detailContent").innerHTML = `
    胎体材质：${w.base}<br>线条粗细：${w.line}<br>贴线进度：${w.progress}%<br>
    阴干日期：${w.dryDate}<br>金粉状态：${w.gold}<br>缺陷位置：${w.defect || "无"}<br>
    交付日期：${w.delivery}<br>当前状态：${w.status}<br>备注：${w.note || "无"}
  `;
  document.querySelector("#editBase").value = w.base;
  document.querySelector("#editTheme").value = w.theme;
  document.querySelector("#editLine").value = w.line;
  document.querySelector("#editDefect").value = w.defect || "";
  document.querySelector("#defectInput").value = "";
  renderDetailGrading(w);
  document.querySelector("#detailLogs").innerHTML = w.logs.map(l => `<div>${l}</div>`).join("") || "暂无";
  if (!dialog.open) dialog.showModal();
}

function renderDetailGrading(w) {
  const open = Grading.openApplication(state, w.id);
  const valid = validCertOf(w.id);
  const certs = state.certificates.filter(c => c.workId === w.id);
  const apps = state.applications.filter(a => a.workId === w.id);
  const check = Grading.eligible(w);
  let head;
  if (valid) head = `当前证书：<b>${valid.certNo}</b>（${valid.grade}，有效）`;
  else if (open) head = `定级待审：判定等级 ${open.grade}，请在证书队列完成审签`;
  else if (check.ok) head = `满足定级条件，可在看板卡片上申请定级`;
  else head = `暂不满足定级条件：${check.reasons.join("、")}`;
  const certRows = certs.map(c => `
    <div class="item plain ${c.status === "有效" ? "" : "overdue"}">
      <b>${c.certNo}</b>（${c.status}）
      <div class="meta">${c.grade} · 检验 ${c.inspector} · 签发 ${c.signer}<br>签发于 ${c.issuedAt}${c.status !== "有效" ? `<br>失效：${c.revokeReason} · ${c.revokedAt}` : ""}<br>存档快照：${c.snapshot.base} / ${c.snapshot.theme} / ${c.snapshot.line} / 缺陷 ${c.snapshot.defect || "无"}</div>
    </div>`).join("");
  const appRows = apps.map(a =>
    `<div>定级单 ${a.createdAt} · ${a.status}${a.status === "已拒绝" ? `（${a.reason}）` : ""}${a.certNo ? ` · 证书 ${a.certNo}` : ""}</div>`).join("");
  document.querySelector("#detailCerts").innerHTML = `${head}${certRows || "<br><br>暂无证书"}${appRows ? `<br>定级记录：<br>${appRows}` : ""}`;
}

function renderSummaries() {
  const todayDry = works.filter(w => w.dryDate <= today && w.status === "待阴干");
  const defects = works.filter(w => w.defect);
  const delivery = [...works].sort((a, b) => a.delivery.localeCompare(b.delivery)).slice(0, 4);
  document.querySelector("#todayDry").innerHTML = todayDry.length ? todayDry.map(w => `<div class="item" onclick="showDetail('${w.id}')"><b>${w.theme}</b><div class="meta">${w.base} · ${w.dryDate}</div></div>`).join("") : `<div class="empty">暂无</div>`;
  document.querySelector("#defectList").innerHTML = defects.length ? defects.map(w => `<div class="item overdue" onclick="showDetail('${w.id}')"><b>${w.theme}</b><div class="meta">${w.defect}</div></div>`).join("") : `<div class="empty">暂无</div>`;
  document.querySelector("#deliveryList").innerHTML = delivery.map(w => `<div class="item" onclick="showDetail('${w.id}')"><b>${w.theme}</b><div class="meta">${w.delivery} · ${w.status}</div></div>`).join("");
}

function renderBoard() {
  const list = filtered();
  board.innerHTML = statuses.map(status => {
    const cards = list.filter(w => w.status === status);
    return `<section class="col">
      <h3><span>${status}</span><span>${cards.length}</span></h3>
      ${cards.length ? cards.map(w => {
        const cert = validCertOf(w.id);
        const open = Grading.openApplication(state, w.id);
        const gradingMeta = cert ? `证书：${cert.certNo} · ${cert.grade}` : open ? `定级待审 · 判定 ${open.grade}` : "";
        const canApply = !cert && !open && Grading.eligible(w).ok;
        return `<article class="item ${w.defect ? "overdue" : ""}" onclick="showDetail('${w.id}')">
          <b>${w.theme}</b>
          <div class="meta">${w.base} · ${w.line}<br>进度 ${w.progress}% · 阴干 ${w.dryDate}<br>金粉：${w.gold} · 交付：${w.delivery}<br>${w.defect ? "缺陷：" + w.defect : "缺陷：无"}${gradingMeta ? `<br>${gradingMeta}` : ""}</div>
          <div class="actions" onclick="event.stopPropagation()">
            ${statuses.map(s => `<button class="${s === status ? "secondary" : ""}" onclick="updateStatus('${w.id}', '${s}')">${s}</button>`).join("")}
            <button class="warn" onclick="recordDefect('${w.id}')">记缺陷</button>
            ${canApply ? `<button class="violet" onclick="applyGrading('${w.id}')">申请定级</button>` : ""}
          </div>
        </article>`;
      }).join("") : `<div class="empty">暂无作品</div>`}
    </section>`;
  }).join("");
}

function renderQueue() {
  const pending = state.applications.filter(a => a.status === "待审");
  const valid = state.certificates.filter(c => c.status === "有效");
  const invalid = state.certificates.filter(c => c.status !== "有效");
  const rejected = state.applications.filter(a => a.status === "已拒绝");
  document.querySelector("#pendingReview").innerHTML = pending.length ? pending.map(a => {
    const w = workOf(a.workId);
    return `<div class="item plain">
      <b>${w ? w.theme : "（作品已删除）"}</b>
      <div class="meta">${w ? `${w.base} · ${w.line}` : ""} · 申请于 ${a.createdAt}</div>
      <div class="review">
        <label>等级<select id="grade-${a.id}">
          <option value="">请选择等级</option>
          ${Grading.GRADES.map(g => `<option ${g === a.grade ? "selected" : ""}>${g}</option>`).join("")}
        </select></label>
        <label>检验人<input id="insp-${a.id}" placeholder="检验人姓名"></label>
        <label>签发人<input id="sign-${a.id}" placeholder="签发人姓名"></label>
        <button class="violet" onclick="completeReview('${a.id}')">审签发证</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty">暂无待审定级单</div>`;
  document.querySelector("#validCerts").innerHTML = valid.length ? valid.map(c => {
    const w = workOf(c.workId);
    return `<div class="item plain"><b>${c.certNo}</b><div class="meta">${w ? w.theme : ""} · ${c.grade}<br>检验 ${c.inspector} · 签发 ${c.signer}<br>${c.issuedAt}</div></div>`;
  }).join("") : `<div class="empty">暂无有效证书</div>`;
  const closedRows = [
    ...invalid.map(c => `<div class="item plain overdue"><b>${c.certNo}</b>（已失效）<div class="meta">${c.revokeReason} · ${c.revokedAt}</div></div>`),
    ...rejected.map(a => {
      const w = workOf(a.workId);
      return `<div class="item plain overdue"><b>定级单已拒绝</b><div class="meta">${w ? w.theme : ""} · ${a.reason}<br>${a.completedAt}</div></div>`;
    })
  ];
  document.querySelector("#closedCerts").innerHTML = closedRows.length ? closedRows.join("") : `<div class="empty">暂无</div>`;
}

function render() {
  renderSummaries();
  renderBoard();
  renderQueue();
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  works.unshift({
    id: crypto.randomUUID(),
    base: data.base,
    theme: data.theme,
    line: data.line,
    progress: Number(data.progress),
    dryDate: data.dryDate,
    gold: data.gold,
    defect: data.defect,
    delivery: data.delivery,
    status: data.status,
    note: data.note,
    logs: [`${new Date().toLocaleString()} 创建作品`]
  });
  form.reset();
  form.dryDate.value = today;
  form.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  save();
  render();
});

document.querySelector("#saveEdit").addEventListener("click", () => {
  const w = workOf(activeId);
  if (!w) return;
  const next = {
    base: document.querySelector("#editBase").value.trim(),
    theme: document.querySelector("#editTheme").value.trim(),
    line: document.querySelector("#editLine").value,
    defect: document.querySelector("#editDefect").value.trim()
  };
  if (!next.base || !next.theme) {
    alert("胎体材质与纹样主题不能为空");
    return;
  }
  const labels = { base: "胎体", theme: "纹样", line: "线条", defect: "缺陷" };
  const changed = Object.keys(next).filter(k => (w[k] || "") !== next[k]);
  if (!changed.length) {
    showDetail(activeId);
    return;
  }
  Object.assign(w, next);
  w.logs.push(`${new Date().toLocaleString()} 修改${changed.map(k => labels[k]).join("、")}`);
  Grading.revalidate(state, w.id, changed);
  save();
  render();
  showDetail(activeId);
});

document.querySelector("#saveDefect").addEventListener("click", () => {
  recordDefect(activeId, document.querySelector("#defectInput").value.trim());
  showDetail(activeId);
});
document.querySelector("#closeDialog").addEventListener("click", () => dialog.close());
document.querySelector("#clearFilters").addEventListener("click", () => {
  themeFilter.value = "";
  statusFilter.value = "";
  render();
});
[statusFilter, themeFilter, sortMode].forEach(el => el.addEventListener("input", render));
document.querySelector("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "lacquer-thread-studio.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

save();
render();
