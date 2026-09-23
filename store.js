/* 存放：localStorage 持久化、旧版数据迁移、证书编号发放 */
window.Store = (() => {
  const STORAGE_KEY = "zfl42Studio";
  const LEGACY_KEY = "zfl42Works";

  function blank() {
    return { works: [], applications: [], certificates: [], certSeq: 1 };
  }

  function normalize(state) {
    state.works = Array.isArray(state.works) ? state.works : [];
    state.applications = Array.isArray(state.applications) ? state.applications : [];
    state.certificates = Array.isArray(state.certificates) ? state.certificates : [];
    state.certSeq = Number(state.certSeq) || 1;
    state.works.forEach(w => { w.logs = Array.isArray(w.logs) ? w.logs : []; });
    return state;
  }

  function load(seedWorks) {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { state = null; }
    if (!state) {
      let legacy = null;
      try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null"); } catch (e) { legacy = null; }
      state = blank();
      state.works = Array.isArray(legacy) && legacy.length ? legacy : seedWorks;
    }
    return normalize(state);
  }

  function save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // 证书编号唯一：顺序发放并跳过已占用编号
  function nextCertNo(state) {
    const year = new Date().getFullYear();
    let certNo;
    do {
      certNo = `QXD-${year}-${String(state.certSeq).padStart(4, "0")}`;
      state.certSeq += 1;
    } while (state.certificates.some(c => c.certNo === certNo));
    return certNo;
  }

  return { STORAGE_KEY, load, save, nextCertNo };
})();
