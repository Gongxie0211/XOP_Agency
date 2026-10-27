// 本部の画面（パソコンで使う）
// 確認待ち → OK / 差し戻し、証明書発行待ち → 発行済み、出面の一覧、現場とメンバーの登録

(function () {
  const { $, esc, call, fmtDay, fmtDateTime, KIND_LABEL, PHOTO_LABEL, MATERIAL_LABEL } = XOP;
  const main = $("#main");
  const itemsEl = $("#items");

  const TABS = [
    { key: "submitted", label: "確認待ち" },
    { key: "approved", label: "証明書発行待ち" },
    { key: "attendance", label: "出面の一覧（月ごと）" },
    { key: "sites", label: "現場の登録" },
    { key: "members", label: "代理店・メンバー" },
  ];
  let tab = "submitted";
  let current = XOP.params.get("report");

  const ACTION_LABEL = { submitted: "報告", resubmitted: "再送", approved: "OK", returned: "差し戻し", certified: "証明書発行" };

  async function start() {
    XOP.demoBanner({ hq: true });
    try {
      await XOP.init({ asHq: true });
      const r = await call("me");
      if (!r.registered || r.member.role !== "hq") {
        main.innerHTML = `<div class="note error">本部の人として登録されていません。</div>`;
        return;
      }
      $("#who").textContent = r.member.name;
      renderTabs();
      await openTab(tab);
    } catch (e) {
      main.innerHTML = `<div class="note error">${esc(e.message)}</div>`;
    }
  }

  function renderTabs(counts = {}) {
    $("#tabs").innerHTML = TABS.map((t) =>
      `<button data-tab="${t.key}" class="${t.key === tab ? "on" : ""}">${t.label}${counts[t.key] !== undefined ? `<span class="count">${counts[t.key]}件</span>` : ""}</button>`).join("");
    document.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
  }

  async function openTab(key) {
    tab = key;
    renderTabs();
    itemsEl.innerHTML = "";
    main.innerHTML = `<div class="spinner">読み込んでいます…</div>`;
    try {
      if (key === "submitted" || key === "approved") return await showList(key);
      if (key === "attendance") return await showAttendance();
      if (key === "sites") return await showSites();
      if (key === "members") return await showMembers();
    } catch (e) {
      main.innerHTML = `<div class="note error">${esc(e.message)}</div>`;
    }
  }

  // ---------- 確認待ち・証明書発行待ち ----------

  async function showList(status) {
    const { reports } = await call("hq_list", { status });
    const [sub, app] = status === "submitted"
      ? [reports.length, (await call("hq_list", { status: "approved" })).reports.length]
      : [(await call("hq_list", { status: "submitted" })).reports.length, reports.length];
    renderTabs({ submitted: sub, approved: app });
    const late = (r) => Date.now() - new Date(r.submitted_at) > 2 * 86400000;
    itemsEl.innerHTML = reports.map((r) => `
      <button class="item ${r.id === current ? "on" : ""}" data-id="${r.id}">
        <b>${esc(r.sites.code)}</b> ${esc(r.sites.label)}<br>
        ${esc(r.sites.agencies?.name)}<br>
        <span class="chip ${r.sites.kind}">${KIND_LABEL[r.sites.kind]}</span>
        ${fmtDateTime(r.submitted_at)}
        ${status === "submitted" && late(r) ? '<span class="chip red">2日経過</span>' : ""}
      </button>`).join("") || `<div class="muted">${status === "submitted" ? "確認待ちの報告はありません。" : "証明書発行待ちはありません。"}</div>`;
    itemsEl.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => showDetail(b.dataset.id)));
    const pick = reports.find((r) => r.id === current) || reports[0];
    if (pick) await showDetail(pick.id);
    else main.innerHTML = `<p class="muted">左の一覧から報告を選んでください。</p>`;
  }

  async function showDetail(id) {
    current = id;
    itemsEl.querySelectorAll("[data-id]").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
    main.innerHTML = `<div class="spinner">読み込んでいます…</div>`;
    const d = await call("hq_detail", { report_id: id });
    const r = d.report, s = d.site;
    const person = (pid) => d.people.find((p) => p.id === pid);
    const resp = person(r.responsible_member_id);
    const ratio = r.area_m2 / r.liters;
    const ratioOk = r.material !== "tile_concrete" || (ratio >= XOP.COVERAGE_M2_PER_L * 0.7 && ratio <= XOP.COVERAGE_M2_PER_L * 1.3);
    const days = d.attendance.reduce((t, a) => t + Number(a.days), 0);

    const img = (p) => `${p.url ? `<img src="${p.url}" alt="" data-zoom>` : '<div class="note error">写真を読めませんでした</div>'}
      <div class="cap ${p.taken_at ? "" : "unknown"}">${PHOTO_LABEL[p.kind]}　${fmtDateTime(p.taken_at)}（${p.source === "camera" ? "その場で撮影" : "写真から選択"}）</div>`;
    const places = [...new Set(d.photos.filter((p) => p.place_no).map((p) => p.place_no))].sort((a, b) => a - b);
    const firstBefore = Math.min(...d.photos.filter((p) => p.kind === "before" && p.taken_at).map((p) => +new Date(p.taken_at)));
    const warns = [];
    for (const n of places) {
      if (!d.photos.some((p) => p.place_no === n && p.kind === "after")) warns.push(`場所${n}：施工後の写真がありません。`);
      if (!d.photos.some((p) => p.place_no === n && p.kind === "before")) warns.push(`場所${n}：施工前の写真がありません。`);
    }
    for (const p of d.photos) {
      if (p.kind === "after" && p.taken_at && +new Date(p.taken_at) < firstBefore) warns.push(`場所${p.place_no}：施工後の写真が施工前より先に撮られています。`);
      if (!p.taken_at) warns.push(`${PHOTO_LABEL[p.kind]}${p.place_no ? `（場所${p.place_no}）` : ""}：撮影日時が読み取れませんでした。`);
    }

    main.innerHTML = `
      <h2>${esc(s.code)}　${esc(s.label)}　<span class="chip ${s.kind}">${KIND_LABEL[s.kind]}</span></h2>
      ${r.status === "approved" ? `<div class="note ok">OK済み（${fmtDateTime(r.reviewed_at)}）。正規施工証明書を作ってお渡ししたら、下のボタンを押してください。</div>` : ""}
      <div class="facts">
        <div><span>代理店</span>${esc(s.agencies?.name)}</div>
        <div><span>施工日</span>${fmtDay(r.start_date)}${r.end_date !== r.start_date ? " 〜 " + fmtDay(r.end_date) : ""}</div>
        <div><span>施工責任者</span>${esc(resp?.name)}${resp?.is_certified ? '（認定済み）' : ' <span class="chip red">未認定</span>'}</div>
        <div><span>面積</span>${r.area_m2}㎡ ${MATERIAL_LABEL[r.material]}</div>
        <div><span>XOP</span>${r.liters}L（約${ratio.toFixed(1)}㎡/L ${ratioOk ? '<span class="chip green">目安内</span>' : '<span class="chip red">目安外</span>'}）</div>
        <div><span>缶</span>${esc(r.cans.join("、") || "ラベルの写真")}</div>
        ${s.kind === "crux" ? `<div><span>出面</span>${days}人日</div>` : ""}
        <div><span>お客様の確認</span>${r.customer_confirmed === true ? "はい" : r.customer_confirmed === false ? "まだ" : "—"}</div>
        <div><span>送った人</span>${esc(person(r.submitted_by)?.name)}　${fmtDateTime(r.submitted_at)}</div>
      </div>
      ${r.note ? `<div class="note info"><b>気づいたこと：</b>${esc(r.note)}</div>` : ""}
      ${warns.map((w) => `<div class="note warn">⚠ ${esc(w)}</div>`).join("")}
      ${places.map((n) => {
        const label = d.photos.find((p) => p.place_no === n && p.place_label)?.place_label;
        return `<div class="place"><div class="lbl">場所${n}${label ? "　" + esc(label) : ""}</div>
          <div class="cols">
            <div>${d.photos.filter((p) => p.place_no === n && p.kind === "before").map(img).join("") || '<div class="muted">施工前なし</div>'}</div>
            <div>${d.photos.filter((p) => p.place_no === n && p.kind === "after").map(img).join("") || '<div class="muted">施工後なし</div>'}</div>
          </div></div>`;
      }).join("")}
      ${d.photos.some((p) => !p.place_no) ? `<div class="place"><div class="lbl">そのほかの写真</div><div class="others">${d.photos.filter((p) => !p.place_no).map((p) => `<div>${img(p)}</div>`).join("")}</div></div>` : ""}
      ${s.kind === "crux" ? `<h2>出面</h2><table class="grid"><tr><th>日付</th><th>名前</th><th>役割</th><th>日数</th></tr>
        ${d.attendance.map((a) => `<tr><td>${fmtDay(a.work_date)}</td><td>${esc(a.person_name)}</td><td>${a.person_role === "responsible" ? "施工責任者" : "手伝い"}</td><td>${Number(a.days) === 1 ? "1日" : "半日"}</td></tr>`).join("")}
        <tr><th colspan="3">合計</th><th>${days}人日</th></tr></table>` : ""}
      <div id="act"></div>
      <div class="log">履歴：${d.events.map((e) => `${fmtDateTime(e.created_at)} ${ACTION_LABEL[e.action]}${e.comment ? `「${esc(e.comment)}」` : ""}`).join("　／　")}</div>`;

    const act = $("#act");
    if (r.status === "submitted") {
      act.innerHTML = `
        <div class="field" style="margin-top:14px"><label>差し戻すときの理由（一言）</label><input type="text" id="comment" placeholder="例：場所2の施工後の写真が暗くて見えにくいです。もう一度入れてください。"></div>
        <div class="actions"><button class="btn primary" id="ok">OK（証明書の準備へ）</button><button class="btn danger" id="ret">差し戻す</button></div>`;
      $("#ok").onclick = () => review(id, "approve");
      $("#ret").onclick = () => review(id, "return");
    } else if (r.status === "approved" && !r.certificate_issued_at) {
      act.innerHTML = `<div class="actions"><button class="btn primary" id="cert">正規施工証明書を発行した</button></div>`;
      $("#cert").onclick = async () => {
        if (!confirm("証明書を発行済みにして、代理店にLINEで知らせますか？")) return;
        try {
          await call("hq_certify", { report_id: id });
          XOP.toast("発行済みにしました");
          current = null;
          openTab("approved");
        } catch (e) {
          XOP.toast(e.message);
        }
      };
    }
    main.querySelectorAll("[data-zoom]").forEach((im) =>
      im.addEventListener("click", () => {
        const z = document.createElement("div");
        z.className = "zoom";
        z.innerHTML = `<img src="${im.src}" alt="">`;
        z.onclick = () => z.remove();
        document.body.appendChild(z);
      }));
  }

  async function review(id, decision) {
    const comment = $("#comment").value.trim();
    if (decision === "return" && !comment) return XOP.toast("差し戻す理由を一言入れてください");
    if (decision === "approve" && !confirm("OKにして、代理店にLINEで知らせますか？")) return;
    try {
      await call("hq_review", { report_id: id, decision, comment });
      XOP.toast(decision === "approve" ? "OKにしました" : "差し戻しました");
      current = null;
      openTab("submitted");
    } catch (e) {
      XOP.toast(e.message);
    }
  }

  // ---------- 出面の一覧 ----------

  async function showAttendance(month) {
    const now = new Date();
    month = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const { rows } = await call("hq_attendance", { month });
    const byAgency = {};
    for (const a of rows) {
      const k = a.reports.sites.agencies?.name || "";
      byAgency[k] = (byAgency[k] || 0) + Number(a.days);
    }
    main.innerHTML = `
      <h2>出面の一覧（クラックスの現場）</h2>
      <div class="row" style="max-width:420px;margin-bottom:12px"><input type="month" id="month" value="${month}"><button class="btn sub small" id="csv" style="flex:none">表計算用に書き出す（CSV）</button></div>
      <p class="muted">本部のOK前のものも入っています（状態の列を見てください）。日当の金額は、この表をもとに本部で計算します。</p>
      <table class="grid"><tr><th>代理店</th><th>合計</th></tr>
        ${Object.entries(byAgency).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}人日</td></tr>`).join("") || '<tr><td colspan="2">この月の出面はありません</td></tr>'}
      </table>
      <h2>明細</h2>
      <table class="grid"><tr><th>日付</th><th>代理店</th><th>現場</th><th>名前</th><th>役割</th><th>日数</th><th>状態</th></tr>
        ${rows.map((a) => `<tr><td>${fmtDay(a.work_date)}</td><td>${esc(a.reports.sites.agencies?.name)}</td><td>${esc(a.reports.sites.code)} ${esc(a.reports.sites.label)}</td><td>${esc(a.person_name)}</td><td>${a.person_role === "responsible" ? "施工責任者" : "手伝い"}</td><td>${Number(a.days)}</td><td>${statusLabel(a.reports.status)}</td></tr>`).join("")}
      </table>`;
    $("#month").onchange = (e) => showAttendance(e.target.value);
    $("#csv").onclick = () => {
      const head = ["日付", "代理店", "現場ID", "現場", "名前", "役割", "日数", "状態"];
      const lines = rows.map((a) => [a.work_date, a.reports.sites.agencies?.name, a.reports.sites.code, a.reports.sites.label, a.person_name,
        a.person_role === "responsible" ? "施工責任者" : "手伝い", Number(a.days), statusLabel(a.reports.status)]);
      const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `出面_${month}.csv`;
      link.click();
    };
  }

  const statusLabel = (s) => ({ submitted: "確認待ち", returned: "差し戻し中", approved: "OK" })[s] || s;

  // ---------- 現場の登録 ----------

  async function showSites() {
    const m = await call("hq_masters");
    const SITE_STATUS = { planned: "報告前", reported: "報告あり", approved: "OK", certified: "証明書発行済み" };
    main.innerHTML = `
      <h2>現場の登録</h2>
      <p class="muted">試験中は、代理店から「○日に施工します」と聞いたら、ここで登録します。お客様の名前・住所・電話は入れず、「○○マンション 共用廊下」のような呼び名だけにしてください。</p>
      <div class="form">
        <div class="field"><label>現場の呼び名</label><input type="text" id="s-label" placeholder="○○マンション 共用廊下"></div>
        <div class="field"><label>代理店</label><select id="s-agency">${m.agencies.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
        <div class="field"><span class="label">現場の種類</span><div class="radios">
          <label><input type="radio" name="s-kind" value="own" checked><span>代理店の現場</span></label>
          <label><input type="radio" name="s-kind" value="crux"><span>クラックスの現場（日当）</span></label></div></div>
        <div class="row"><div class="field"><label>施工予定日</label><input type="date" id="s-date"></div>
          <div class="field"><label>素材</label><select id="s-mat">${Object.entries(MATERIAL_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div class="field"><label>面積の見込み（㎡）</label><input type="number" id="s-area" step="0.1"></div></div>
        <button class="btn primary" id="s-add">登録して現場IDを出す</button>
      </div>
      <h2>登録した現場（新しい順）</h2>
      <table class="grid"><tr><th>現場ID</th><th>呼び名</th><th>代理店</th><th>種類</th><th>予定日</th><th>状態</th><th>報告用のリンク（QRにする）</th></tr>
        ${m.sites.map((s) => `<tr><td>${esc(s.code)}</td><td>${esc(s.label)}</td><td>${esc(s.agencies?.name)}</td><td>${KIND_LABEL[s.kind]}</td><td>${fmtDay(s.planned_date)}</td><td>${SITE_STATUS[s.status]}</td><td style="font-size:12px">${esc(siteLink(s.code))}</td></tr>`).join("")}
      </table>`;
    $("#s-add").onclick = async () => {
      try {
        const { site } = await call("hq_create_site", {
          label: $("#s-label").value, agency_id: $("#s-agency").value,
          kind: document.querySelector('input[name="s-kind"]:checked').value,
          planned_date: $("#s-date").value, material: $("#s-mat").value, estimated_area: $("#s-area").value,
        });
        XOP.toast(`${site.code} を登録しました`);
        showSites();
      } catch (e) {
        XOP.toast(e.message);
      }
    };
  }

  function siteLink(code) {
    const cfg = window.XOP_CONFIG || {};
    return cfg.liffId ? `https://liff.line.me/${cfg.liffId}?site=${code}` : `index.html?site=${code}`;
  }

  // ---------- 代理店・メンバー ----------

  async function showMembers() {
    const m = await call("hq_masters");
    const agencyName = (id) => m.agencies.find((a) => a.id === id)?.name || "本部";
    main.innerHTML = `
      <h2>代理店・メンバー</h2>
      <div class="form">
        <div class="row"><div class="field"><label>代理店を追加</label><input type="text" id="a-name" placeholder="代理店名"></div>
          <button class="btn sub small" id="a-add" style="flex:none;margin-top:10px">追加</button></div>
      </div>
      <div class="form">
        <div class="field"><label>メンバーを追加（招待コードが出ます。LINEで本人に送ってください）</label><input type="text" id="m-name" placeholder="名前"></div>
        <div class="row">
          <div class="field"><select id="m-role"><option value="agency">代理店の人</option><option value="hq">本部の人</option></select></div>
          <div class="field"><select id="m-agency">${m.agencies.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
        </div>
        <label style="display:block;margin-bottom:10px"><input type="checkbox" id="m-cert"> 研修を受けた施工責任者</label>
        <button class="btn primary" id="m-add">追加して招待コードを出す</button>
      </div>
      <table class="grid"><tr><th>名前</th><th>所属</th><th>施工責任者</th><th>LINE</th><th>招待コード</th></tr>
        ${m.members.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(agencyName(x.agency_id))}</td><td>${x.is_certified ? "認定済み" : ""}</td><td>${x.linked ? "つながっています" : "まだ"}</td><td><b>${x.linked ? "" : esc(x.invite_code || "")}</b></td></tr>`).join("")}
      </table>`;
    $("#a-add").onclick = async () => {
      try {
        await call("hq_create_agency", { name: $("#a-name").value.trim() });
        showMembers();
      } catch (e) {
        XOP.toast(e.message);
      }
    };
    $("#m-add").onclick = async () => {
      try {
        const { member } = await call("hq_create_member", {
          name: $("#m-name").value.trim(), role: $("#m-role").value, agency_id: $("#m-agency").value, is_certified: $("#m-cert").checked,
        });
        alert(`${member.name}さんの招待コード：${member.invite_code}\n\nクラックスのLINE公式アカウントを友だち追加して、メニューの「施工完了報告」を開き、このコードを入れてもらってください。`);
        showMembers();
      } catch (e) {
        XOP.toast(e.message);
      }
    };
  }

  start();
})();
