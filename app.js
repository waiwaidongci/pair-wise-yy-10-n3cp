/*
 * 页面层 app.js
 * 负责：工序看板、定级审签证书队列、证书台账、作品详情与履历。
 * 所有判定/写入都调用 Grading（→ Store），页面只渲染 Store.load() 的单一事实源，
 * 因此刷新后看板、队列、履历天然一致。
 */
(function () {
  "use strict";

  const statuses = ["贴线中", "待阴干", "上金粉", "待交付"];
  const today = new Date().toISOString().slice(0, 10);

  const $ = sel => document.querySelector(sel);
  const form = $("#workForm");
  const board = $("#board");
  const statusFilter = $("#statusFilter");
  const themeFilter = $("#themeFilter");
  const sortMode = $("#sortMode");
  const queueEl = $("#certQueue");
  const ledgerEl = $("#certLedger");
  const dialog = $("#detailDialog");
  let activeId = null;
  let toastTimer = null;

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
  }

  function toast(msg, ok) {
    const bar = $("#toast");
    bar.textContent = msg;
    bar.className = ok === false ? "show error" : "show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { bar.className = ""; }, 3200);
  }

  function state() {
    return Store.load();
  }

  function workById(id) {
    return state().works.find(w => w.id === id) || null;
  }

  function run(fn, okMsg) {
    try {
      fn();
      render();
      if (okMsg) toast(okMsg, true);
      return true;
    } catch (err) {
      toast("整单拒绝：" + err.message, false);
      return false;
    }
  }

  /* ---------- 定级/证书徽章 ---------- */
  function certBadge(w) {
    const st = state();
    const valid = Grading.validCertificate(st, w.id);
    if (valid) return `<span class="badge cert">证书 ${esc(valid.number)} · ${esc(valid.grade)}</span>`;
    const open = Grading.activeGrading(st, w.id);
    if (open) return `<span class="badge grading">${esc(open.origin)}中 · 待审签</span>`;
    if (st.certificates.some(c => c.workId === w.id)) return `<span class="badge void">旧证已失效 · 只读</span>`;
    if (Grading.eligible(w)) return `<span class="badge ready">已满工无缺陷 · 可申请定级</span>`;
    return "";
  }

  /* ---------- 顶部汇总 ---------- */
  function renderSummaries() {
    const works = state().works;
    const todayDry = works.filter(w => w.dryDate <= today && w.status === "待阴干");
    const defects = works.filter(w => w.defect);
    const delivery = [...works].sort((a, b) => a.delivery.localeCompare(b.delivery)).slice(0, 4);
    const row = w => `<div class="item ${w.defect ? "overdue" : ""}" data-act="detail" data-id="${w.id}"><b>${esc(w.theme)}</b><div class="meta">${esc(w.base)} · ${esc(w.dryDate)}${w.defect ? "<br>缺陷：" + esc(w.defect) : ""}</div></div>`;
    $("#todayDry").innerHTML = todayDry.length ? todayDry.map(row).join("") : `<div class="empty">暂无</div>`;
    $("#defectList").innerHTML = defects.length ? defects.map(row).join("") : `<div class="empty">暂无</div>`;
    $("#deliveryList").innerHTML = delivery.length ? delivery.map(w => `<div class="item" data-act="detail" data-id="${w.id}"><b>${esc(w.theme)}</b><div class="meta">${esc(w.delivery)} · ${esc(w.status)}</div></div>`).join("") : `<div class="empty">暂无</div>`;
  }

  /* ---------- 工序看板 ---------- */
  function filtered() {
    return state().works
      .filter(w => !statusFilter.value || w.status === statusFilter.value)
      .filter(w => !themeFilter.value || w.theme.includes(themeFilter.value.trim()))
      .sort((a, b) => (a[sortMode.value] || "").localeCompare(b[sortMode.value] || ""));
  }

  function renderBoard() {
    const list = filtered();
    board.innerHTML = statuses.map(status => {
      const cards = list.filter(w => w.status === status);
      return `<section class="col">
        <h3><span>${status}</span><span>${cards.length}</span></h3>
        ${cards.length ? cards.map(w => {
          const st = state();
          const open = Grading.activeGrading(st, w.id);
          const valid = Grading.validCertificate(st, w.id);
          const canApply = Grading.eligible(w) && !open && !valid;
          return `<article class="item ${w.defect ? "overdue" : ""}" data-act="detail" data-id="${w.id}">
            <b>${esc(w.theme)}</b>
            <div class="meta">${esc(w.base)} · ${esc(w.line)}<br>进度 ${w.progress}% · 阴干 ${esc(w.dryDate)}<br>金粉：${esc(w.gold)} · 交付：${esc(w.delivery)}<br>${w.defect ? "缺陷：" + esc(w.defect) : "缺陷：无"}</div>
            <div class="badges">${certBadge(w)}</div>
            <div class="actions">
              ${statuses.map(s => `<button class="${s === status ? "secondary" : ""}" data-act="status" data-id="${w.id}" data-status="${esc(s)}">${s}</button>`).join("")}
              <button class="warn" data-act="defect" data-id="${w.id}">记缺陷</button>
              ${canApply ? `<button class="violet" data-act="apply" data-id="${w.id}">申请定级</button>` : ""}
              ${open ? `<button class="violet" data-act="detail" data-id="${w.id}">审签进度</button>` : ""}
            </div>
          </article>`;
        }).join("") : `<div class="empty">暂无作品</div>`}
      </section>`;
    }).join("");
  }

  /* ---------- 定级审签 · 证书队列（未结束定级） ---------- */
  function renderQueue() {
    const st = state();
    const open = st.gradings
      .filter(g => g.state === "定级中")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!open.length) {
      queueEl.innerHTML = `<div class="empty">队列已清空：没有待审签的定级。满工且无缺陷的作品可在看板上申请。</div>`;
      return;
    }
    queueEl.innerHTML = open.map(g => {
      const w = st.works.find(x => x.id === g.workId);
      if (!w) return "";
      const suggested = Grading.suggestGrade(w);
      const stillOk = Grading.eligible(w);
      return `<div class="queue-card ${g.origin === "重判" ? "rejudge" : ""}">
        <div class="qhead">
          <b>${esc(w.theme)}</b> <span class="tag ${g.origin === "重判" ? "rejudge-tag" : ""}">${esc(g.origin)}</span>
          <span class="meta qtime">${esc(g.createdAt)}</span>
        </div>
        <div class="meta">${esc(w.base)} · ${esc(w.line)} · ${esc(w.gold)} · 进度 ${w.progress}% · 缺陷：${esc(w.defect || "无")}</div>
        ${stillOk ? "" : `<div class="qerror">作品当前已不满足定级条件（进度未满或出现缺陷），直接整单拒绝后整改。</div>`}
        <div class="qform" data-grading="${g.id}">
          <label>等级
            <select class="f-grade">
              ${Grading.GRADES.map(grade => `<option ${grade === suggested ? "selected" : ""}>${grade}</option>`).join("")}
            </select>
          </label>
          <label>检验人<input class="f-inspector" placeholder="检验人姓名" list="staffList"></label>
          <label>签发人<input class="f-issuer" placeholder="不得与检验人同人" list="staffList"></label>
          <div class="actions qactions">
            <button class="violet" data-act="sign" data-id="${g.id}">签发并出证</button>
            <button class="danger" data-act="reject" data-id="${g.id}">整单拒绝</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  /* ---------- 证书台账（已结束定级全部留痕；旧证只读） ---------- */
  function renderLedger() {
    const st = state();
    const rows = [...st.certificates]
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    if (!rows.length) {
      ledgerEl.innerHTML = `<div class="empty">尚无发放记录。</div>`;
      return;
    }
    ledgerEl.innerHTML = rows.map(c => {
      const w = st.works.find(x => x.id === c.workId);
      return `<article class="cert ${c.state === "有效" ? "" : "voided"}">
        <div class="cert-head">
          <b>${esc(c.number)}</b>
          <span class="certstate ${c.state === "有效" ? "ok" : "dead"}">${esc(c.state)}</span>
        </div>
        <div class="meta">
          作品：${w ? esc(w.theme) + "（" + esc(w.base) + "）" : "作品已删除"}<br>
          等级：${esc(c.grade)} · 检验：${esc(c.inspector)} · 签发：${esc(c.issuer)}<br>
          发证：${esc(c.issuedAt)}<br>
          出证时取值：${esc(c.snapshot.base)} / ${esc(c.snapshot.theme)} / ${esc(c.snapshot.line)} / 缺陷「${esc(c.snapshot.defect || "无")}」<br>
          ${c.state === "有效"
            ? (w ? `<button class="secondary sm" data-act="detail" data-id="${w.id}">查看作品</button>` : "")
            : `<span class="voidnote">只读存档 · ${esc(c.voidedAt)} 失效：${esc(c.reason)}</span>`}
        </div>
      </article>`;
    }).join("");
  }

  /* ---------- 作品详情 / 编辑 / 履历 ---------- */
  function showDetail(id) {
    activeId = id;
    const w = workById(id);
    if (!w) { dialog.close(); return; }
    const st = state();
    const valid = Grading.validCertificate(st, w.id);
    const oldCerts = st.certificates.filter(c => c.workId === w.id && c.state !== "有效");
    const open = Grading.activeGrading(st, w.id);

    $("#detailTitle").textContent = w.theme + " · " + w.base;
    $("#detailContent").innerHTML = `
      <div class="badges">${certBadge(w)}</div>
      ${valid ? `<div class="certline okline">有效证书 <b>${esc(valid.number)}</b>（${esc(valid.grade)}）· 检验 ${esc(valid.inspector)} / 签发 ${esc(valid.issuer)} · ${esc(valid.issuedAt)}</div>` : ""}
      ${oldCerts.length ? oldCerts.map(c => `<div class="certline deadline">旧证 ${esc(c.number)}（${esc(c.grade)}）只读 · ${esc(c.voidedAt)} 失效：${esc(c.reason)}</div>`).join("") : ""}
      ${open ? `<div class="certline">${esc(open.origin)}定级单在队列中（${esc(open.createdAt)}），到「定级审签」处填写等级、检验人、签发人。</div>` : ""}
      <div class="meta">阴干 ${esc(w.dryDate)} · 交付 ${esc(w.delivery)} · 状态 ${esc(w.status)} · 备注：${esc(w.note || "无")}</div>`;

    $("#baseInput").value = w.base;
    $("#themeInput").value = w.theme;
    $("#lineInput").value = w.line;
    $("#progressInput").value = w.progress;
    $("#goldInput").value = w.gold;
    $("#defectEditInput").value = w.defect || "";
    $("#warnVoid").style.display = (valid || open) ? "block" : "none";

    $("#historyLog").innerHTML = w.logs.map(line => `<div class="logline">${esc(line)}</div>`).join("");
    dialog.showModal();
  }

  function saveDetail() {
    if (!activeId) return;
    const ok = run(() => Grading.changeWork({
      workId: activeId,
      base: $("#baseInput").value,
      theme: $("#themeInput").value,
      line: $("#lineInput").value,
      progress: $("#progressInput").value,
      gold: $("#goldInput").value,
      defect: $("#defectEditInput").value
    }), "已保存；若改动胎体/纹样/线条/缺陷，旧证已失效并按新值重判");
    if (ok) showDetail(activeId);
  }

  function render() {
    renderSummaries();
    renderBoard();
    renderQueue();
    renderLedger();
  }

  /* ---------- 事件 ---------- */
  document.body.addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    if (act === "detail") { showDetail(id); return; }
    if (act === "status") { run(() => Grading.setStatus(id, btn.dataset.status), "状态已更新"); return; }
    if (act === "apply") { run(() => Grading.applyGrading(id), "定级申请已进入证书队列"); return; }
    if (act === "defect") {
      const value = prompt("输入断线/翘线位置");
      if (value === null) return;
      run(() => Grading.appendDefect(id, value), "缺陷已记录；相关证书已失效并重判");
      return;
    }
    if (act === "sign") {
      const box = btn.closest(".qform");
      run(() => Grading.signGrading({
        gradingId: btn.dataset.id,
        grade: box.querySelector(".f-grade").value,
        inspector: box.querySelector(".f-inspector").value,
        issuer: box.querySelector(".f-issuer").value
      }), "审签通过，证书已发放并唯一编号");
      return;
    }
    if (act === "reject") {
      const reason = prompt("整单拒绝理由（不留半截，整改后可重新申请）");
      if (reason === null) return;
      run(() => Grading.rejectGrading(btn.dataset.id, reason), "定级单已整单拒绝");
    }
  });

  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    run(() => Grading.createWork(data), "作品已加入工坊");
    form.reset();
    form.dryDate.value = today;
    form.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  });

  $("#saveDetail").addEventListener("click", saveDetail);
  $("#closeDialog").addEventListener("click", () => dialog.close());
  $("#clearFilters").addEventListener("click", () => {
    themeFilter.value = "";
    statusFilter.value = "";
    render();
  });
  [statusFilter, themeFilter, sortMode].forEach(el => el.addEventListener("input", render));
  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state(), null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lacquer-thread-studio.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  /* 初始化 */
  form.dryDate.value = today;
  form.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  statusFilter.innerHTML = `<option value="">全部状态</option>` + statuses.map(s => `<option>${s}</option>`).join("");
  render();
})();
