/* 判定：定级资格、等级判定、审签发证、证书失效与按新值重判 */
window.Grading = (() => {
  const GRADES = ["特级", "一级", "二级", "三级"];
  const WATCHED_FIELDS = ["base", "theme", "line", "defect"];
  const FIELD_LABELS = { base: "胎体", theme: "纹样", line: "线条", defect: "缺陷" };

  function now() {
    return new Date().toLocaleString();
  }

  function openApplication(state, workId) {
    return state.applications.find(a => a.workId === workId && a.status === "待审") || null;
  }

  // 只有进度已满且无缺陷的作品才能进入定级
  function eligible(work) {
    const reasons = [];
    if (Number(work.progress) < 100) reasons.push("贴线进度未满");
    if ((work.defect || "").trim()) reasons.push("存在缺陷");
    return { ok: reasons.length === 0, reasons };
  }

  // 等级判定：线条越细、金粉越足，等级越高
  function judgeGrade(work) {
    if (work.line === "细线") return work.gold === "已上金粉" ? "特级" : work.gold === "试扫粉" ? "一级" : "二级";
    if (work.line === "混合线") return work.gold === "已上金粉" ? "一级" : "二级";
    if (work.line === "中线") return work.gold === "已上金粉" ? "二级" : "三级";
    return "三级";
  }

  function snapshot(work) {
    return {
      base: work.base,
      theme: work.theme,
      line: work.line,
      defect: work.defect || "",
      progress: Number(work.progress),
      gold: work.gold
    };
  }

  function log(state, workId, text) {
    const work = state.works.find(w => w.id === workId);
    if (work) work.logs.push(`${now()} ${text}`);
  }

  // 申请定级：同一作品仅允许一条未结束定级；重复或并发申请沿用首次结果
  function apply(state, workId) {
    const work = state.works.find(w => w.id === workId);
    if (!work) return { ok: false, error: "作品不存在" };
    const existing = openApplication(state, workId);
    if (existing) return { ok: true, application: existing, reused: true };
    const check = eligible(work);
    if (!check.ok) return { ok: false, error: check.reasons.join("、") };
    const application = {
      id: crypto.randomUUID(),
      workId,
      grade: judgeGrade(work),
      inspector: "",
      signer: "",
      status: "待审",
      reason: "",
      certNo: "",
      snapshot: snapshot(work),
      createdAt: now(),
      completedAt: ""
    };
    state.applications.unshift(application);
    log(state, workId, `申请定级，判定等级 ${application.grade}`);
    return { ok: true, application, reused: false };
  }

  // 审签发证：等级、检验人、签发人齐备且检验≠签发，否则整单拒绝、不留半截；已结束的单沿用首次结果
  function complete(state, applicationId, input) {
    const application = state.applications.find(a => a.id === applicationId);
    if (!application) return { ok: false, error: "定级单不存在" };
    if (application.status !== "待审") {
      return {
        ok: application.status === "已签发",
        application,
        certificate: state.certificates.find(c => c.applicationId === applicationId) || null,
        reused: true,
        error: application.reason || ""
      };
    }
    const grade = (input.grade || "").trim();
    const inspector = (input.inspector || "").trim();
    const signer = (input.signer || "").trim();
    const problems = [];
    if (!grade) problems.push("缺少等级");
    if (!inspector) problems.push("缺少检验人");
    if (!signer) problems.push("缺少签发人");
    if (inspector && signer && inspector === signer) problems.push("检验人与签发人不得为同一人");
    if (problems.length) {
      application.status = "已拒绝";
      application.reason = problems.join("；");
      application.completedAt = now();
      log(state, application.workId, `定级整单拒绝：${application.reason}`);
      return { ok: false, application, error: application.reason, reused: false };
    }
    application.grade = grade;
    application.inspector = inspector;
    application.signer = signer;
    let certificate = state.certificates.find(c => c.applicationId === applicationId);
    if (!certificate) {
      certificate = {
        certNo: window.Store.nextCertNo(state),
        applicationId,
        workId: application.workId,
        grade,
        inspector,
        signer,
        snapshot: application.snapshot,
        status: "有效",
        issuedAt: now(),
        revokedAt: "",
        revokeReason: ""
      };
      state.certificates.unshift(certificate);
    }
    application.status = "已签发";
    application.certNo = certificate.certNo;
    application.completedAt = now();
    log(state, application.workId, `签发证书 ${certificate.certNo}（${grade}，检验 ${inspector}，签发 ${signer}）`);
    return { ok: true, application, certificate, reused: false };
  }

  // 关键值变更：已发证书失效（旧证书只读保留），未结束定级单按新值重判，不再满足条件则整单拒绝
  function revalidate(state, workId, changedFields) {
    const hit = changedFields.filter(f => WATCHED_FIELDS.includes(f));
    if (!hit.length) return { revoked: [] };
    const work = state.works.find(w => w.id === workId);
    if (!work) return { revoked: [] };
    const reason = `作品${hit.map(f => FIELD_LABELS[f]).join("、")}变更`;
    const revoked = state.certificates.filter(c => c.workId === workId && c.status === "有效");
    revoked.forEach(c => {
      c.status = "已失效";
      c.revokedAt = now();
      c.revokeReason = reason;
    });
    if (revoked.length) log(state, workId, `${reason}，证书 ${revoked.map(c => c.certNo).join("、")} 失效`);
    const check = eligible(work);
    const open = openApplication(state, workId);
    if (open) {
      if (check.ok) {
        open.grade = judgeGrade(work);
        open.snapshot = snapshot(work);
        log(state, workId, `${reason}，未结束定级单按新值重判为 ${open.grade}`);
      } else {
        open.status = "已拒绝";
        open.reason = `${reason}后不再满足定级条件（${check.reasons.join("、")}）`;
        open.completedAt = now();
        log(state, workId, `定级整单拒绝：${open.reason}`);
      }
    } else if (revoked.length && check.ok) {
      const result = apply(state, workId);
      if (result.ok) log(state, workId, `按新值重判，新定级单等级 ${result.application.grade}`);
    }
    return { revoked };
  }

  return { GRADES, WATCHED_FIELDS, openApplication, eligible, judgeGrade, apply, complete, revalidate };
})();
