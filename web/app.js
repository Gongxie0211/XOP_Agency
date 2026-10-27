// 代理店の画面（施工責任者がLINEの中で開く）
// 流れ：現場を選ぶ → ① 施工の内容 → ② 写真 → ③ 写真の組み合わせ → ④ 出面（クラックスの現場だけ）→ ⑤ 確認して送信

(function () {
  const { $, esc, call, drafts, idb, fmtDay, fmtDateTime, isoDate, KIND_LABEL, PHOTO_LABEL } = XOP;
  const view = $("#view");
  const bar = $("#bar");
  const barInner = $("#bar-inner");
  const backBtn = $("#back");

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  let me = null;   // { member, agency }
  let st = null;   // いま入力している報告

  // ---------- 画面の切りかえ ----------

  function setTitle(t) {
    $("#title").textContent = t;
  }
  function setBar(html) {
    bar.hidden = !html;
    barInner.innerHTML = html || "";
  }
  function setBack(fn) {
    backBtn.hidden = !fn;
    backBtn.onclick = fn;
  }
  function showError(e) {
    console.error(e);
    XOP.toast(e.message || String(e));
  }

  async function start() {
    XOP.demoBanner();
    try {
      await XOP.init();
      const r = await call("me");
      if (!r.registered) return showRegister();
      me = r;
      const code = XOP.params.get("site");
      if (code) {
        const { site_id } = await call("site_by_code", { code });
        return openSite(site_id);
      }
      showSites();
    } catch (e) {
      view.innerHTML = `<div class="note error">${esc(e.message)}</div>`;
    }
  }

  // ---------- 最初の登録（招待コード） ----------

  function showRegister() {
    setTitle("はじめての方へ");
    setBack(null);
    setBar("");
    view.innerHTML = `
      <div class="card">
        <p>クラックス本部から届いた<b>招待コード</b>を入れてください。最初の1回だけです。</p>
        <div class="field"><label>招待コード（6文字）</label><input type="text" id="code" autocomplete="off" autocapitalize="characters"></div>
        <button class="btn primary" id="go">登録する</button>
      </div>
      <p class="muted">招待コードが分からないときは、このトークで本部に聞いてください。</p>`;
    $("#go").onclick = async () => {
      try {
        me = await call("register", { invite_code: $("#code").value });
        showSites();
      } catch (e) {
        showError(e);
      }
    };
  }

  // ---------- ② 現場を選ぶ ----------

  async function showSites() {
    st = null;
    setTitle("施工完了報告");
    setBack(null);
    setBar("");
    view.innerHTML = `<div class="spinner">読み込んでいます…</div>`;
    try {
      const { sites } = await call("my_sites");
      const items = sites.map((s) => {
        const draft = drafts.load(s.id);
        const returned = s.report?.status === "returned";
        return `<button class="card" data-site="${s.id}" ${returned ? 'style="border-color:#c26a1b"' : draft ? 'style="background:#fff8ec"' : ""}>
          <span class="chip ${s.kind}">${KIND_LABEL[s.kind]}</span>
          ${returned ? '<span class="chip red">直してください</span>' : draft ? '<span class="chip gray">下書きあり</span>' : ""}<br>
          <span class="site-code">${esc(s.code)}</span>　${esc(s.label)}<br>
          <span class="muted">予定：${s.planned_date ? fmtDay(s.planned_date) : "未定"}　${XOP.MATERIAL_LABEL[s.material]}${s.estimated_area ? ` 約${s.estimated_area}㎡` : ""}</span>
          ${returned && s.report.hq_comment ? `<div class="note warn">本部より：${esc(s.report.hq_comment)}</div>` : ""}
        </button>`;
      });
      view.innerHTML = `
        <p style="font-weight:bold;margin:4px 0 10px">報告する現場を選んでください</p>
        ${items.join("") || '<div class="card muted">報告する現場はありません。施工の予定が決まったら、このトークで本部に知らせてください。</div>'}
        ${!XOP.demo && liff.isApiAvailable && liff.isApiAvailable("scanCodeV2") ? '<button class="btn sub" id="scan">現場のQRを読み取る</button>' : ""}
        <p class="muted" style="margin-top:12px">現場が見つからないときは、このトークで本部に連絡してください。</p>`;
      view.querySelectorAll("[data-site]").forEach((b) => (b.onclick = () => openSite(b.dataset.site)));
      $("#scan")?.addEventListener("click", scanQr);
    } catch (e) {
      view.innerHTML = `<div class="note error">${esc(e.message)}</div>`;
    }
  }

  async function scanQr() {
    try {
      const { value } = await liff.scanCodeV2();
      const code = (String(value).match(/T-\d{4,}/i) || [])[0];
      if (!code) return XOP.toast("現場のQRではないようです");
      const { site_id } = await call("site_by_code", { code });
      openSite(site_id);
    } catch (e) {
      showError(e);
    }
  }

  // ---------- 報告の入力 ----------

  async function openSite(siteId) {
    view.innerHTML = `<div class="spinner">読み込んでいます…</div>`;
    try {
      const d = await call("site_detail", { site_id: siteId });
      const site = d.site;
      const draft = drafts.load(siteId);
      const certified = d.people.filter((p) => p.is_certified);
      const defaultResp = certified.find((p) => p.id === me.member.id) || certified[0] || d.people[0];
      const day0 = site.planned_date || isoDate(new Date());

      st = {
        site,
        people: d.people,
        returned: d.report?.status === "returned" ? d.report : null,
        step: 1,
        fields: {
          start_date: day0,
          end_date: day0,
          responsible_member_id: defaultResp?.id || "",
          material: site.material,
          area_m2: site.estimated_area ?? "",
          liters: "",
          cans: [""],
          customer_confirmed: null,
          note: "",
        },
        photos: [],
        places: {},
        attendance: [],
      };

      if (d.report) {
        // 差し戻された報告を直すとき：送った内容から始める
        const r = d.report;
        Object.assign(st.fields, {
          start_date: r.start_date, end_date: r.end_date, responsible_member_id: r.responsible_member_id,
          material: r.material, area_m2: r.area_m2, liters: r.liters, cans: r.cans.length ? r.cans : [""],
          customer_confirmed: r.customer_confirmed, note: r.note || "",
        });
        st.photos = d.photos.map((p) => ({
          id: p.id, kind: p.kind, place_no: p.place_no, taken_at: p.taken_at, source: p.source,
          storage_path: p.storage_path, uploaded: true, existing: true, thumb: p.url,
        }));
        for (const p of d.photos) if (p.place_no && p.place_label) st.places[p.place_no] = p.place_label;
        st.attendance = d.attendance.map(({ person_name, person_role, work_date, days }) => ({ person_name, person_role, work_date, days: Number(days) }));
      }

      if (draft) {
        Object.assign(st.fields, draft.fields);
        st.places = draft.places || st.places;
        st.attendance = draft.attendance || st.attendance;
        st.step = draft.step || 1;
        st.photos = [];
        for (const p of draft.photos || []) {
          if (p.existing) {
            const prev = d.photos?.find((x) => x.storage_path === p.storage_path);
            if (prev) st.photos.push({ ...p, thumb: prev.url });
          } else {
            const blob = await idb.get("draft-photo:" + p.id);
            if (blob) st.photos.push({ ...p, thumb: URL.createObjectURL(blob) });
          }
        }
      }
      if (site.kind === "crux" && st.attendance.length === 0) {
        const resp = d.people.find((p) => p.id === st.fields.responsible_member_id);
        if (resp) st.attendance.push({ person_name: resp.name, person_role: "responsible", work_date: st.fields.start_date, days: 1 });
      }
      renderStep();
    } catch (e) {
      view.innerHTML = `<div class="note error">${esc(e.message)}</div>`;
      setBack(showSites);
    }
  }

  function saveDraft() {
    if (!st) return;
    drafts.save(st.site.id, {
      fields: st.fields,
      places: st.places,
      attendance: st.attendance,
      step: st.step,
      photos: st.photos.map(({ thumb, ...p }) => p),
    });
  }

  function steps() {
    const list = [
      { n: 1, title: "施工の内容", render: renderContent },
      { n: 2, title: "写真", render: renderPhotos },
      { n: 3, title: "写真の組み合わせ", render: renderPairs },
    ];
    if (st.site.kind === "crux") list.push({ n: 4, title: "出面", render: renderAttendance });
    list.push({ n: 5, title: "確認して送信", render: renderConfirm });
    return list;
  }

  function go(delta) {
    const list = steps();
    const i = list.findIndex((s) => s.n === st.step);
    const next = list[i + delta];
    if (!next) return delta < 0 ? showSites() : null;
    st.step = next.n;
    saveDraft();
    renderStep();
    window.scrollTo(0, 0);
  }

  function renderStep() {
    const list = steps();
    const i = Math.max(0, list.findIndex((s) => s.n === st.step));
    const cur = list[i];
    st.step = cur.n;
    setTitle(`${st.site.code} ${cur.title}`);
    setBack(() => go(-1));
    const head = `
      <div class="steps">${list.map((s, k) => `<span class="${k <= i ? "on" : ""}"></span>`).join("")}</div>
      <div class="step-title">${i + 1} / ${list.length}　${esc(st.site.label)}　<span class="chip ${st.site.kind}">${KIND_LABEL[st.site.kind]}</span></div>
      ${st.returned && i === 0 ? `<div class="note warn"><b>本部より：</b>${esc(st.returned.hq_comment || "")}<br>直すところだけ直して、もう一度送ってください。</div>` : ""}`;
    view.innerHTML = head + '<div id="step"></div>';
    cur.render($("#step"));
    const last = i === list.length - 1;
    if (!last) {
      setBar(`<button class="btn sub" id="prev">戻る</button><button class="btn primary" id="next">次へ（${list[i + 1].title}）</button>`);
      $("#prev").onclick = () => go(-1);
      $("#next").onclick = () => go(1);
    }
  }

  // ---------- ① 施工の内容 ----------

  function renderContent(el) {
    const f = st.fields;
    const people = st.people;
    el.innerHTML = `
      <div class="field"><span class="label">施工日</span>
        <div class="row"><input type="date" data-f="start_date" value="${esc(f.start_date)}"><span class="unit">〜</span><input type="date" data-f="end_date" value="${esc(f.end_date)}"></div>
      </div>
      <div class="field"><label>施工責任者（研修を受けた人）</label>
        <select data-f="responsible_member_id">
          ${people.filter((p) => p.is_certified).map((p) => `<option value="${p.id}" ${p.id === f.responsible_member_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
      </div>
      <div class="field"><span class="label">素材</span>
        <div class="radios">
          ${Object.entries(XOP.MATERIAL_LABEL).map(([k, v]) => `<label><input type="radio" name="material" data-f="material" value="${k}" ${f.material === k ? "checked" : ""}><span>${v}</span></label>`).join("")}
        </div>
      </div>
      <div class="field"><label>施工した面積</label><div class="row"><input type="number" inputmode="decimal" step="0.1" min="0" data-f="area_m2" value="${esc(f.area_m2)}"><span class="unit">㎡</span></div></div>
      <div class="field"><label>使ったXOPの量</label><div class="row"><input type="number" inputmode="decimal" step="0.5" min="0" data-f="liters" value="${esc(f.liters)}"><span class="unit">L</span></div></div>
      <div id="ratio"></div>
      <div class="field"><span class="label">使った缶（CR番号）</span>
        <div id="cans">${f.cans.map((c, i) => `<input type="text" data-can="${i}" value="${esc(c)}" placeholder="例：CR-2410-0031" style="margin-bottom:6px">`).join("")}</div>
        <div class="row"><button class="btn sub small" id="add-can">＋ 缶を追加</button></div>
        <div class="muted" style="margin:8px 0 4px">番号を打つ代わりに、ラベルの写真でもかまいません。</div>
        <div id="can-photos"></div>
      </div>`;
    el.querySelectorAll("[data-f]").forEach((input) => {
      const ev = input.type === "radio" || input.tagName === "SELECT" ? "change" : "input";
      input.addEventListener(ev, () => {
        f[input.dataset.f] = input.value;
        if (input.dataset.f === "start_date" && f.end_date < f.start_date) {
          f.end_date = f.start_date;
          el.querySelector('[data-f="end_date"]').value = f.end_date;
        }
        updateRatio();
        saveDraft();
      });
    });
    el.querySelectorAll("[data-can]").forEach((input) =>
      input.addEventListener("input", () => {
        f.cans[+input.dataset.can] = input.value;
        saveDraft();
      }));
    $("#add-can").onclick = () => {
      f.cans.push("");
      saveDraft();
      renderStep();
    };
    photoSection($("#can-photos"), "can_label", "缶のラベルを撮る");
    updateRatio();
  }

  function updateRatio() {
    const box = $("#ratio");
    if (!box) return;
    const a = Number(st.fields.area_m2), l = Number(st.fields.liters);
    if (st.fields.material !== "tile_concrete" || !(a > 0) || !(l > 0)) return (box.innerHTML = "");
    const expect = a / XOP.COVERAGE_M2_PER_L;
    const ratio = a / l;
    const ok = ratio >= XOP.COVERAGE_M2_PER_L * 0.7 && ratio <= XOP.COVERAGE_M2_PER_L * 1.3;
    box.innerHTML = ok
      ? `<div class="note ok">目安は約${XOP.COVERAGE_M2_PER_L}㎡/Lです。${a}㎡なら約${expect.toFixed(1)}Lなので問題ありません。</div>`
      : `<div class="note warn">目安は約${XOP.COVERAGE_M2_PER_L}㎡/L（${a}㎡なら約${expect.toFixed(1)}L）です。今の数字だと${ratio.toFixed(1)}㎡/Lになります。合っているか確認してください。このまま進めることもできます。</div>`;
  }

  // ---------- ② 写真 ----------

  function renderPhotos(el) {
    el.innerHTML = `
      <p class="muted" style="margin-top:0">その場で撮っても、先に撮っておいた写真をあとから選んでもかまいません。入れた欄で「施工前」「施工後」が決まります。</p>
      <div class="sec-head before"><span>施工前の写真</span><span>2枚以上</span></div><div class="sec-body" id="ph-before"></div>
      <div class="sec-head after"><span>施工後の写真</span><span>2枚以上・施工前と同じ位置から</span></div><div class="sec-body" id="ph-after"></div>
      <div class="sec-head boundary"><span>施工中（境目）の写真</span><span>できれば1枚</span></div><div class="sec-body" id="ph-boundary"></div>`;
    photoSection($("#ph-before"), "before");
    photoSection($("#ph-after"), "after");
    photoSection($("#ph-boundary"), "boundary");
  }

  function photoBand(p) {
    const place = p.place_no ? `場所${p.place_no} ` : "";
    return `<div class="band"><b class="${p.kind}">${PHOTO_LABEL[p.kind]}</b> ${place}${esc(fmtDateTime(p.taken_at))}${p.source === "library" ? "（写真から）" : ""}</div>`;
  }

  function photoSection(el, kind, addLabel) {
    const list = st.photos.filter((p) => p.kind === kind);
    el.innerHTML = `
      <div class="photos">${list.map((p) => `
        <div class="photo"><img src="${p.thumb}" alt="">${photoBand(p)}
          <button class="del" data-del="${p.id}" aria-label="消す">×</button></div>`).join("")}</div>
      <div class="adds">
        <label class="add">📷 ${addLabel || "その場で撮る"}<input type="file" accept="image/*" capture="environment" data-src="camera"></label>
        <label class="add">🖼 写真から選ぶ<input type="file" accept="image/*" multiple data-src="library"></label>
      </div>`;
    el.querySelectorAll("input[type=file]").forEach((input) =>
      input.addEventListener("change", async () => {
        const files = Array.from(input.files || []);
        input.value = "";
        await addPhotos(kind, files, input.dataset.src);
        photoSection(el, kind, addLabel);
      }));
    el.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("この写真を外しますか？")) return;
        const p = st.photos.find((x) => x.id === b.dataset.del);
        st.photos = st.photos.filter((x) => x !== p);
        if (!p.existing) await idb.del("draft-photo:" + p.id).catch(() => {});
        saveDraft();
        photoSection(el, kind, addLabel);
      }));
  }

  async function addPhotos(kind, files, source) {
    if (!files.length) return;
    XOP.toast(files.length > 1 ? `${files.length}枚の写真を準備しています…` : "写真を準備しています…", 1500);
    for (const file of files) {
      try {
        let taken = await XOP.readExifDate(file);
        if (!taken && source === "camera") taken = new Date().toISOString();
        const blob = await XOP.resizePhoto(file);
        const id = uid();
        await idb.put("draft-photo:" + id, blob);
        const paired = kind === "before" || kind === "after";
        st.photos.push({
          id, kind, source, taken_at: taken,
          place_no: paired ? st.photos.filter((p) => p.kind === kind).length + 1 : null,
          thumb: URL.createObjectURL(blob),
        });
      } catch (e) {
        console.error(e);
        XOP.toast("読めない写真がありました（" + file.name + "）");
      }
    }
    saveDraft();
  }

  // ---------- ③ 写真の組み合わせ ----------

  function placeCount() {
    return Math.max(0, ...st.photos.filter((p) => p.place_no).map((p) => p.place_no));
  }

  function photoWarnings() {
    const w = [];
    const before = st.photos.filter((p) => p.kind === "before");
    const after = st.photos.filter((p) => p.kind === "after");
    for (let n = 1; n <= placeCount(); n++) {
      const b = before.some((p) => p.place_no === n), a = after.some((p) => p.place_no === n);
      if (b && !a) w.push(`場所${n}の施工後の写真がまだありません。`);
      if (!b && a) w.push(`場所${n}の施工前の写真がまだありません。`);
    }
    const firstBefore = Math.min(...before.filter((p) => p.taken_at).map((p) => +new Date(p.taken_at)));
    for (const p of after) {
      if (p.taken_at && +new Date(p.taken_at) < firstBefore) {
        w.push(`場所${p.place_no}の施工後の写真が、施工前の写真より<b>先に</b>撮られています（${fmtDateTime(p.taken_at)}）。合っていますか？`);
      }
    }
    const from = +new Date(st.fields.start_date + "T00:00") - 86400000;
    const to = +new Date(st.fields.end_date + "T00:00") + 2 * 86400000;
    for (const p of st.photos) {
      if (p.taken_at && (+new Date(p.taken_at) < from || +new Date(p.taken_at) >= to)) {
        w.push(`${PHOTO_LABEL[p.kind]}${p.place_no ? `（場所${p.place_no}）` : ""}の写真が、施工日と違う日（${fmtDateTime(p.taken_at)}）に撮られています。合っていますか？`);
      }
    }
    const unknown = st.photos.filter((p) => !p.taken_at).length;
    if (unknown) w.push(`撮影日時が読み取れない写真が${unknown}枚あります。本部には「撮影日時不明」と表示されます。`);
    return w;
  }

  function renderPairs(el) {
    const n = Math.max(1, placeCount());
    const opts = (p) => Array.from({ length: n + 1 }, (_, i) => i + 1)
      .map((k) => `<option value="${k}" ${k === p.place_no ? "selected" : ""}>場所${k}</option>`).join("");
    const cell = (p) => `<div class="photo"><img src="${p.thumb}" alt="">${photoBand(p)}
      ${p.existing ? "" : `<select data-place="${p.id}">${opts(p)}</select>`}</div>`;
    let html = `<p class="muted" style="margin-top:0">同じ場所の施工前と施工後が並ぶようにしてください。左上の「場所」で組みかえられます。場所の名前は入れなくてもかまいません。</p>`;
    for (let k = 1; k <= n; k++) {
      const b = st.photos.filter((p) => p.kind === "before" && p.place_no === k);
      const a = st.photos.filter((p) => p.kind === "after" && p.place_no === k);
      if (!b.length && !a.length) continue;
      html += `<div class="pair-place card">
        <div class="head"><b>場所${k}</b><input type="text" data-label="${k}" placeholder="名前（例：廊下の奥から）" value="${esc(st.places[k] || "")}"></div>
        <div class="pair">
          <div>${b.map(cell).join("") || '<div class="empty">施工前の写真がありません</div>'}</div>
          <div>${a.map(cell).join("") || '<div class="empty">施工後の写真がありません</div>'}</div>
        </div></div>`;
    }
    const warns = photoWarnings();
    html += warns.map((t) => `<div class="note warn">⚠ ${t}</div>`).join("");
    if (!warns.length) html += `<div class="note ok">写真の組み合わせに問題はありません。</div>`;
    html += `<button class="btn sub" id="to-photos" style="margin-top:8px">写真を足す・外す</button>`;
    el.innerHTML = html;
    el.querySelectorAll("[data-place]").forEach((s) =>
      s.addEventListener("change", () => {
        st.photos.find((p) => p.id === s.dataset.place).place_no = +s.value;
        saveDraft();
        renderPairs(el);
      }));
    el.querySelectorAll("[data-label]").forEach((i) =>
      i.addEventListener("input", () => {
        st.places[i.dataset.label] = i.value;
        saveDraft();
      }));
    $("#to-photos").onclick = () => go(-1);
  }

  // ---------- ④ 出面（クラックスの現場だけ） ----------

  function renderAttendance(el) {
    const names = st.people.map((p) => p.name);
    const total = st.attendance.reduce((s, a) => s + Number(a.days), 0);
    el.innerHTML = `
      <p class="muted" style="margin-top:0">入った人と日数を入れてください。交通費・道具・消耗材はクラックス持ちなので、入力は要りません。</p>
      ${st.attendance.map((a, i) => `
        <div class="att-row">
          <div>
            <div class="who">${esc(a.person_name)} <span class="muted">${a.person_role === "responsible" ? "施工責任者" : "手伝い"}</span></div>
            <div class="ctl" style="margin-top:6px">
              <input type="date" data-i="${i}" data-k="work_date" value="${esc(a.work_date)}">
              <select data-i="${i}" data-k="days"><option value="1" ${Number(a.days) === 1 ? "selected" : ""}>1日</option><option value="0.5" ${Number(a.days) === 0.5 ? "selected" : ""}>半日</option></select>
            </div>
          </div>
          <button class="btn danger small" data-rm="${i}">外す</button>
        </div>`).join("")}
      <div class="card">
        <div class="field" style="margin-bottom:8px"><label>人を追加</label>
          <div class="row">
            <input type="text" id="new-name" list="people" placeholder="名前">
            <select id="new-role" style="flex:0 0 32%"><option value="helper">手伝い</option><option value="responsible">施工責任者</option></select>
          </div>
          <datalist id="people">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
        </div>
        <div class="row"><input type="date" id="new-date" value="${esc(st.attendance.at(-1)?.work_date || st.fields.start_date)}">
          <select id="new-days"><option value="1">1日</option><option value="0.5">半日</option></select>
          <button class="btn sub small" id="add-att" style="flex:none">＋ 追加</button></div>
        <div class="muted" style="margin-top:6px">2日以上の現場は、日ごとに1行ずつ入れてください。</div>
      </div>
      <div class="total">合計：${total}人日</div>`;
    el.querySelectorAll("[data-k]").forEach((i) =>
      i.addEventListener("change", () => {
        st.attendance[+i.dataset.i][i.dataset.k] = i.dataset.k === "days" ? Number(i.value) : i.value;
        saveDraft();
        renderAttendance(el);
      }));
    el.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => {
        st.attendance.splice(+b.dataset.rm, 1);
        saveDraft();
        renderAttendance(el);
      }));
    $("#add-att").onclick = () => {
      const name = $("#new-name").value.trim();
      if (!name) return XOP.toast("名前を入れてください");
      st.attendance.push({ person_name: name, person_role: $("#new-role").value, work_date: $("#new-date").value, days: Number($("#new-days").value) });
      saveDraft();
      renderAttendance(el);
    };
  }

  // ---------- ⑤ 確認して送信 ----------

  function renderConfirm(el) {
    const f = st.fields;
    const resp = st.people.find((p) => p.id === f.responsible_member_id);
    const count = (k) => st.photos.filter((p) => p.kind === k).length;
    const missing = XOP.reportMissing(st.site, f, st.photos, st.attendance);
    const warns = photoWarnings();
    const jump = (n, label) => `<a href="#" data-jump="${n}">${label}</a>`;
    el.innerHTML = `
      <table class="list">
        <tr><th>現場</th><td>${esc(st.site.code)} ${esc(st.site.label)}</td></tr>
        <tr><th>${jump(1, "施工日")}</th><td>${fmtDay(f.start_date)}${f.end_date !== f.start_date ? " 〜 " + fmtDay(f.end_date) : ""}</td></tr>
        <tr><th>${jump(1, "施工責任者")}</th><td>${esc(resp?.name || "")}</td></tr>
        <tr><th>${jump(1, "面積・素材")}</th><td>${esc(f.area_m2)}㎡　${XOP.MATERIAL_LABEL[f.material]}</td></tr>
        <tr><th>${jump(1, "XOP")}</th><td>${esc(f.liters)}L（${esc(f.cans.filter(Boolean).join("、") || (count("can_label") ? "ラベルの写真" : ""))}）</td></tr>
        <tr><th>${jump(2, "写真")}</th><td>施工前${count("before")}・施工後${count("after")}・境目${count("boundary")}</td></tr>
        ${st.site.kind === "crux" ? `<tr><th>${jump(4, "出面")}</th><td>${st.attendance.reduce((s, a) => s + Number(a.days), 0)}人日（${st.attendance.length}行）</td></tr>` : ""}
      </table>
      ${missing.length ? `<div class="note error">足りない項目があります：${missing.join("、")}</div>` : ""}
      ${warns.length ? `<div class="note warn">写真について${warns.length}件の確認があります。${jump(3, "見る")}（このまま送ることもできます）</div>` : ""}
      <div class="field" style="margin-top:14px"><span class="label">お客様（発注者）は完了を確認しましたか</span>
        <div class="radios">
          <label><input type="radio" name="cc" value="yes" ${f.customer_confirmed === true ? "checked" : ""}><span>はい</span></label>
          <label><input type="radio" name="cc" value="no" ${f.customer_confirmed === false ? "checked" : ""}><span>まだ</span></label>
        </div>
      </div>
      <div class="field"><label>気づいたこと（なくてもかまいません）</label>
        <textarea id="note" placeholder="天候、下地の状態、お客様の声など。お客様の名前・電話番号は書かないでください。">${esc(f.note)}</textarea>
      </div>
      <div id="send-status"></div>`;
    el.querySelectorAll("[data-jump]").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        st.step = +a.dataset.jump;
        saveDraft();
        renderStep();
      }));
    el.querySelectorAll('input[name="cc"]').forEach((r) =>
      r.addEventListener("change", () => {
        f.customer_confirmed = r.value === "yes";
        saveDraft();
      }));
    $("#note").addEventListener("input", (e) => {
      f.note = e.target.value;
      saveDraft();
    });
    setBar(`<button class="btn sub" id="prev">戻る</button><button class="btn primary" id="send" ${missing.length ? "disabled" : ""}>本部に送る</button>`);
    $("#prev").onclick = () => go(-1);
    $("#send").onclick = send;
  }

  let sending = false;
  async function send() {
    if (sending) return;
    sending = true;
    const btn = $("#send");
    const status = $("#send-status");
    btn.disabled = true;
    try {
      // 写真を1枚ずつ送る（送れたものは下書きに印をつけ、やり直しのときに送り直さない）
      const todo = st.photos.filter((p) => !p.uploaded);
      let done = 0;
      for (const p of todo) {
        status.innerHTML = `<div class="progress">写真を送っています… ${done + 1} / ${todo.length}</div>`;
        const blob = await idb.get("draft-photo:" + p.id);
        const stamped = await XOP.stampPhoto(blob, {
          kind: p.kind, siteCode: st.site.code, placeNo: p.place_no, placeLabel: st.places[p.place_no], takenAt: p.taken_at,
        });
        const { path, signed_url } = await call("photo_upload_url", { site_id: st.site.id });
        await XOP.upload(signed_url, stamped);
        p.storage_path = path;
        p.uploaded = true;
        saveDraft();
        done++;
      }
      status.innerHTML = `<div class="progress">報告を送っています…</div>`;
      const f = st.fields;
      await call("submit_report", {
        site_id: st.site.id,
        fields: { ...f, cans: f.cans.map((c) => c.trim()).filter(Boolean) },
        photos: st.photos.map((p) => ({
          kind: p.kind, place_no: p.place_no, place_label: st.places[p.place_no] || null,
          storage_path: p.storage_path, taken_at: p.taken_at || null, source: p.source,
        })),
        attendance: st.site.kind === "crux" ? st.attendance : [],
      });
      await drafts.clear(st.site.id, st.photos.filter((p) => !p.existing).map((p) => "draft-photo:" + p.id));
      showDone();
    } catch (e) {
      console.error(e);
      status.innerHTML = `<div class="note error">送れませんでした：${esc(e.message)}<br>入れた内容と写真は残っています。電波の良いところで、もう一度「本部に送る」を押してください。</div>`;
      btn.disabled = false;
      window.addEventListener("online", () => $("#send") && send(), { once: true });
    } finally {
      sending = false;
    }
  }

  function showDone() {
    const site = st.site;
    setTitle("送信しました");
    setBack(null);
    view.innerHTML = `
      <div class="done">
        <div class="big">✅</div>
        <h2>完了報告を受け付けました</h2>
        <p>${esc(site.code)} ${esc(site.label)}</p>
        <div class="chat"><div class="bubble">本部で確認して、2営業日以内にLINEでお知らせします。OKになったら、お客様に<b>正規施工証明書</b>をお渡しできます。おつかれさまでした。</div></div>
      </div>`;
    setBar(`<button class="btn sub" id="list">ほかの現場を見る</button>${XOP.demo ? "" : '<button class="btn primary" id="close">閉じる</button>'}`);
    $("#list").onclick = showSites;
    $("#close")?.addEventListener("click", () => liff.closeWindow());
    st = null;
  }

  start();
})();
