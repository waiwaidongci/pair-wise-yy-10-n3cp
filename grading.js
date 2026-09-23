/*
 * 判定层 grading.js
 * 负责：定级资格判定、审签规则（检验/签发齐备且不得同人）、
 *       证书发放与唯一编号、作品核心值变动导致旧证失效并按新值重判。
 * 所有写入都走 Store.commit / Store.request，保证整单原子、重复请求沿用首次结果。
 */
(function (global) {
  "use strict";

  const GRADES = ["珍品", "一级", "二级", "合格"];
  const FIELD_LABELS = { base: "胎体材质", theme: "纹样主题", line: "线条粗细", defect: "缺陷", progress: "贴线进度", gold: "金粉状态" };

  function now() {
    return new Date().toLocaleString();
  }

  function getWork(state, id) {
    const w = state.works.find(x => x.id === id);
    if (!w) throw new Error("作品不存在或已删除");
    return w;
  }

  function snapshot(w) {
    return { base: w.base, theme: w.theme, line: w.line, defect: w.defect || "", progress: w.progress, gold: w.gold };
  }

  /* 可申请定级：进度已满且无缺陷 */
  function eligible(w) {
    return Number(w.progress) >= 100 && !w.defect;
  }

  function activeGrading(state, workId) {
    return state.gradings.find(g => g.workId === workId && g.state === "定级中") || null;
  }

  function validCertificate(state, workId) {
    return state.certificates.find(c => c.workId === workId && c.state === "有效") || null;
  }

  function openCandidates(state) {
    return state.works.filter(eligible).filter(w => !activeGrading(state, w.id) && !validCertificate(state, w.id));
  }

  function applyKey(workId) {
    return "apply:" + workId;
  }

  /* 申请一条未结束定级：重复/并发申请沿用首次结果；首次定级已结束则可重新申请 */
  function applyGrading(workId) {
    return Store.request(applyKey(workId), function (draft) {
      const w = getWork(draft, workId);
      const existing = activeGrading(draft, workId);
      if (existing) return { type: "grading", id: existing.id };
      if (validCertificate(draft, workId)) throw new Error("该作品已有有效证书，不能重复申请");
      if (!eligible(w)) throw new Error("仅进度 100% 且无缺陷的作品可申请定级");
      const g = {
        id: Store.uid(), workId: workId, state: "定级中", origin: "申请",
        grade: "", inspector: "", issuer: "",
        createdAt: now(), decidedAt: "", certificateId: null,
        closedAt: "", reason: "", snapshot: snapshot(w)
      };
      draft.gradings.push(g);
      w.logs.push(g.createdAt + " 提交定级申请，进入证书队列");
      return { type: "grading", id: g.id };
    }, function (record, draft) {
      const g = record.type === "grading" && draft.gradings.find(x => x.id === record.id);
      return !!g && g.state === "定级中";
    });
  }

  /*
   * 定级审签：等级、检验人、签发人齐备，检验与签发不得同人。
   * 所有校验先在草稿上跑完，任何一项不满足都抛错 → 整单拒绝，不留半截。
   */
  function signGrading(input) {
    const gradingId = String(input.gradingId || "");
    const grade = String(input.grade || "").trim();
    const inspector = String(input.inspector || "").trim();
    const issuer = String(input.issuer || "").trim();
    return Store.commit(function (draft) {
      const g = draft.gradings.find(x => x.id === gradingId);
      if (!g) throw new Error("定级单不存在");
      if (g.state !== "定级中") throw new Error("该定级已结束：" + g.state);
      if (!GRADES.includes(grade)) throw new Error("请选择等级");
      if (!inspector) throw new Error("检验人不能为空");
      if (!issuer) throw new Error("签发人不能为空");
      if (inspector === issuer) throw new Error("检验人与签发人不得为同一人");

      const w = getWork(draft, g.workId);
      if (!eligible(w)) throw new Error("作品已不满足定级条件（进度未满或出现缺陷）");

      const stamp = now();
      const number = Store.nextCertificateNumber(draft);
      g.state = "已签发";
      g.grade = grade;
      g.inspector = inspector;
      g.issuer = issuer;
      g.decidedAt = stamp;
      g.certificateId = number;
      g.closedAt = stamp;
      g.snapshot = snapshot(w);

      const cert = {
        number: number,
        workId: w.id,
        gradingId: g.id,
        grade: grade,
        inspector: inspector,
        issuer: issuer,
        issuedAt: stamp,
        state: "有效",
        voidedAt: "",
        reason: "",
        snapshot: snapshot(w)
      };
      draft.certificates.push(cert);
      w.logs.push(stamp + " 定级 " + grade + "：检验 " + inspector + " / 签发 " + issuer + "，证书 " + number + " 已发放");
      return { type: "certificate", id: number };
    });
  }

  /* 拒绝定级：同样要求填写拒绝理由，整单关闭 */
  function rejectGrading(gradingId, reasonRaw) {
    const reason = String(reasonRaw || "").trim();
    return Store.commit(function (draft) {
      const g = draft.gradings.find(x => x.id === gradingId);
      if (!g) throw new Error("定级单不存在");
      if (g.state !== "定级中") throw new Error("该定级已结束：" + g.state);
      if (!reason) throw new Error("请填写拒绝理由");
      const stamp = now();
      g.state = "已拒绝";
      g.reason = reason;
      g.closedAt = stamp;
      const w = draft.works.find(x => x.id === g.workId);
      if (w) w.logs.push(stamp + " 定级被拒绝：" + reason + "（整改后可重新申请）");
      return { type: "grading", id: g.id };
    });
  }

  /* 取消定级（整改期间退出队列），同样整单关闭、可重新申请 */
  function cancelGrading(gradingId, reasonRaw) {
    const reason = String(reasonRaw || "").trim() || "作品信息变更";
    return Store.commit(function (draft) {
      const g = draft.gradings.find(x => x.id === gradingId);
      if (!g) throw new Error("定级单不存在");
      if (g.state !== "定级中") throw new Error("该定级已结束：" + g.state);
      const stamp = now();
      g.state = "已取消";
      g.reason = reason;
      g.closedAt = stamp;
      const w = draft.works.find(x => x.id === g.workId);
      if (w) w.logs.push(stamp + " 定级取消：" + reason);
      return { type: "grading", id: g.id };
    });
  }

  function rejudge(draft, workId, stamp, changes) {
    const w = getWork(draft, workId);
    const changeText = changes.map(c => FIELD_LABELS[c.key] + "「" + (c.oldValue || "无") + " → " + (c.newValue || "无") + "」").join("、");

    /* 旧证书一律失效且只读 */
    for (const cert of draft.certificates.filter(c => c.workId === workId && c.state === "有效")) {
      cert.state = "已失效";
      cert.voidedAt = stamp;
      cert.reason = "作品核心信息变更：" + changeText;
    }
    /* 未结束定级随之关闭，避免带着旧值走完审签 */
    for (const g of draft.gradings.filter(x => x.workId === workId && x.state === "定级中")) {
      g.state = "已取消";
      g.closedAt = stamp;
      g.reason = "作品核心信息变更，按新值重判";
    }

    w.logs.push(stamp + " 核心信息变更：" + changeText);
    if (draft.certificates.some(c => c.workId === workId && c.state === "已失效")) {
      w.logs.push(stamp + " 已发证书随之失效，旧证书转为只读存档");
    }
    /* 新值仍满足资格 → 自动开一条重判定级，等待重新审签 */
    if (eligible(w)) {
      const g = {
        id: Store.uid(), workId: workId, state: "定级中", origin: "重判",
        grade: "", inspector: "", issuer: "",
        createdAt: stamp, decidedAt: "", certificateId: null,
        closedAt: "", reason: "", snapshot: snapshot(w)
      };
      draft.gradings.push(g);
      w.logs.push(stamp + " 按新值重新判定，已进入证书队列");
      return g.id;
    }
    w.logs.push(stamp + " 当前不满足定级条件，整改完成后可重新申请");
    return null;
  }

  /*
   * 修改作品核心字段：胎体、纹样、线条或缺陷（进度/金粉随表单一并提交）。
   * 变更会让已发证书失效并按新值重判；非核心字段（备注/日期/状态）只记日志。
   */
  function changeWork(input) {
    const workId = String(input.workId || "");
    const patch = {
      base: String(input.base || "").trim(),
      theme: String(input.theme || "").trim(),
      line: String(input.line || "").trim(),
      progress: Number(input.progress),
      gold: String(input.gold || "").trim(),
      defect: String(input.defect || "").trim()
    };
    if (!patch.base) throw new Error("胎体材质不能为空");
    if (!patch.theme) throw new Error("纹样主题不能为空");
    if (isNaN(patch.progress) || patch.progress < 0 || patch.progress > 100) throw new Error("贴线进度需在 0–100 之间");

    return Store.commit(function (draft) {
      const w = getWork(draft, workId);
      const before = snapshot(w);
      const keys = ["base", "theme", "line", "progress", "gold", "defect"];
      const changes = [];
      for (const key of keys) {
        if (String(before[key]) !== String(patch[key])) changes.push({ key: key, oldValue: before[key], newValue: patch[key] });
      }
      const stamp = now();
      keys.forEach(key => { w[key] = patch[key]; });
      if (w.progress >= 100) w.status = "待交付";

      /* 仅胎体、纹样、线条、缺陷四类改动触发失效与重判 */
      const TRIGGER_KEYS = ["base", "theme", "line", "defect"];
      const triggers = changes.filter(c => TRIGGER_KEYS.includes(c.key));
      let newGradingId = null;
      const hadCert = draft.certificates.some(c => c.workId === workId && c.state === "有效");
      const hadOpen = draft.gradings.some(g => g.workId === workId && g.state === "定级中");
      if (triggers.length && (hadCert || hadOpen)) {
        newGradingId = rejudge(draft, workId, stamp, triggers);
      } else if (changes.length) {
        w.logs.push(stamp + " 信息更新：" + changes.map(c => FIELD_LABELS[c.key] + "「" + (c.oldValue || "无") + " → " + (c.newValue || "无") + "」").join("、"));
      }
      return { type: "work", id: workId, newGradingId: newGradingId };
    });
  }

  /* 新增作品 */
  function createWork(data) {
    const w = {
      id: Store.uid(),
      base: String(data.base || "").trim(),
      theme: String(data.theme || "").trim(),
      line: String(data.line || "中线"),
      progress: Number(data.progress) || 0,
      dryDate: String(data.dryDate || ""),
      gold: String(data.gold || "未处理"),
      defect: String(data.defect || "").trim(),
      delivery: String(data.delivery || ""),
      status: String(data.status || "贴线中"),
      note: String(data.note || ""),
      logs: [now() + " 创建作品"]
    };
    if (!w.base) throw new Error("胎体材质不能为空");
    if (!w.theme) throw new Error("纹样主题不能为空");
    Store.commit(function (draft) { draft.works.unshift(w); });
    return w.id;
  }

  function appendDefect(workId, text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("请填写缺陷位置");
    const w = Store.load().works.find(x => x.id === workId);
    if (!w) throw new Error("作品不存在或已删除");
    const merged = w.defect ? w.defect + "; " + value : value;
    return changeWork(Object.assign({ workId: workId }, snapshot(w), { defect: merged }));
  }

  function setStatus(workId, status) {
    return Store.commit(function (draft) {
      const w = getWork(draft, workId);
      const stamp = now();
      w.status = status;
      if (status === "待阴干") w.dryDate = new Date().toISOString().slice(0, 10);
      if (status === "上金粉") w.gold = "已上金粉";
      if (status === "待交付") w.progress = 100;
      w.logs.push(stamp + " 更新为 " + status);
      return { type: "work", id: workId };
    });
  }

  /* 看板/队列展示用的等级建议（按作品当前值判，供审签表单预填） */
  function suggestGrade(w) {
    if (w.line === "细线" && w.gold === "已上金粉") return "珍品";
    if (w.line === "混合线" || w.gold === "已上金粉") return "一级";
    if (w.line === "中线") return "二级";
    return "合格";
  }

  global.Grading = {
    GRADES,
    eligible,
    activeGrading,
    validCertificate,
    openCandidates,
    applyGrading,
    signGrading,
    rejectGrading,
    cancelGrading,
    changeWork,
    createWork,
    appendDefect,
    setStatus,
    suggestGrade,
    applyKey
  };
})(window);
