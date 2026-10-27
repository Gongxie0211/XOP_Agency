// 代理店の画面と本部の画面で共通に使う処理
// - LINE(LIFF)のログインと API の呼び出し
// - 写真の撮影日時の読み取り・縮小・文字入れ
// - 下書きの保存（IndexedDB）
// - お試しモード（LINEやSupabaseなしで、このブラウザの中だけで動く）

(function () {
  const cfg = window.XOP_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const demo = !cfg.liffId || params.has("demo");

  // ---------- 小さな道具 ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (d) => (d ? `${new Date(d).getMonth() + 1}/${new Date(d).getDate()}` : "");
  const fmtDateTime = (d) => {
    if (!d) return "撮影日時不明";
    const t = new Date(d);
    return `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  };
  const isoDate = (d) => {
    const t = new Date(d);
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  };
  const WEEK = "日月火水木金土";
  const fmtDay = (s) => (s ? `${fmtDate(s + "T00:00")}（${WEEK[new Date(s + "T00:00").getDay()]}）` : "");
  const KIND_LABEL = { own: "自分の現場", crux: "クラックスの現場" };
  const MATERIAL_LABEL = { tile_concrete: "タイル・コンクリート", other: "その他" };
  const PHOTO_LABEL = { before: "施工前", after: "施工後", boundary: "施工中（境目）", can_label: "缶のラベル" };
  const COVERAGE_M2_PER_L = 20; // タイル・コンクリートの目安

  function toast(text, ms = 3500) {
    let box = $("#toast");
    if (!box) {
      box = document.createElement("div");
      box.id = "toast";
      document.body.appendChild(box);
    }
    const item = document.createElement("div");
    item.className = "toast-item";
    item.textContent = text;
    box.appendChild(item);
    setTimeout(() => item.remove(), ms);
  }

  // ---------- 下書きの保存（写真は大きいので IndexedDB） ----------

  const idb = (() => {
    let dbp;
    const open = () =>
      (dbp ||= new Promise((resolve, reject) => {
        const r = indexedDB.open("xop-line-report", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("blobs");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction("blobs", mode);
        const req = fn(t.objectStore("blobs"));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
      });
    };
    return {
      get: (k) => tx("readonly", (s) => s.get(k)),
      put: (k, v) => tx("readwrite", (s) => s.put(v, k)),
      del: (k) => tx("readwrite", (s) => s.delete(k)),
    };
  })();

  const drafts = {
    key: (siteId) => `xop-draft-${siteId}`,
    load(siteId) {
      try {
        return JSON.parse(localStorage.getItem(this.key(siteId)) || "null");
      } catch {
        return null;
      }
    },
    save(siteId, data) {
      try {
        localStorage.setItem(this.key(siteId), JSON.stringify({ ...data, savedAt: Date.now() }));
      } catch {}
    },
    async clear(siteId, photoIds = []) {
      try {
        localStorage.removeItem(this.key(siteId));
      } catch {}
      for (const id of photoIds) await idb.del(id).catch(() => {});
    },
  };

  // ---------- 写真 ----------

  // JPEG の Exif から撮影日時（DateTimeOriginal、なければ DateTime）を読む。読めなければ null。
  async function readExifDate(file) {
    try {
      const buf = await file.slice(0, 256 * 1024).arrayBuffer();
      const v = new DataView(buf);
      if (v.getUint16(0) !== 0xffd8) return null;
      let off = 2;
      while (off + 4 < v.byteLength) {
        const marker = v.getUint16(off);
        const size = v.getUint16(off + 2);
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
        if ((marker & 0xff00) !== 0xff00) break;
        off += 2 + size;
      }
    } catch {}
    return null;
  }

  function parseTiff(v, start) {
    const little = v.getUint16(start) === 0x4949;
    const u16 = (o) => v.getUint16(start + o, little);
    const u32 = (o) => v.getUint32(start + o, little);
    const readAscii = (o, n) => {
      let s = "";
      for (let i = 0; i < n - 1; i++) s += String.fromCharCode(v.getUint8(start + o + i));
      return s;
    };
    const tags = (ifd) => {
      const out = {};
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        out[u16(e)] = { type: u16(e + 2), count: u32(e + 4), value: u32(e + 8) };
      }
      return out;
    };
    const ifd0 = tags(u32(4));
    let raw = null;
    if (ifd0[0x8769]) {
      const exif = tags(ifd0[0x8769].value);
      if (exif[0x9003]) raw = readAscii(exif[0x9003].value, exif[0x9003].count);
    }
    if (!raw && ifd0[0x0132]) raw = readAscii(ifd0[0x0132].value, ifd0[0x0132].count);
    const m = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m || m[1] === "0000") return null;
    // Exif の時刻は撮った場所の時刻（ここでは日本時間として扱う）
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString();
  }

  async function loadBitmap(blob) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(blob, { imageOrientation: "from-image" });
      } catch {}
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const canvasBlob = (c, q = 0.85) => new Promise((r) => c.toBlob(r, "image/jpeg", q));

  // 長い辺を maxSide までに縮める（電波が弱くても送れるように）
  async function resizePhoto(file, maxSide = 1600) {
    const img = await loadBitmap(file);
    const w = img.width, h = img.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return canvasBlob(c);
  }

  // 写真の下に帯をつけ、「施工前／施工後・現場ID・場所・撮影日時」を入れる
  async function stampPhoto(blob, { kind, siteCode, placeNo, placeLabel, takenAt }) {
    const img = await loadBitmap(blob);
    const band = Math.max(36, Math.round(img.height * 0.07));
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height + band;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    g.fillStyle = "#111";
    g.fillRect(0, img.height, c.width, band);
    const fs = Math.round(band * 0.5);
    g.font = `bold ${fs}px "Hiragino Sans", "Noto Sans JP", "IPAPGothic", sans-serif`;
    g.textBaseline = "middle";
    const y = img.height + band / 2;
    const head = PHOTO_LABEL[kind] || kind;
    g.fillStyle = kind === "before" ? "#7cc4ff" : kind === "after" ? "#ffb35c" : "#ffd34d";
    g.fillText(head, fs * 0.6, y);
    const headW = g.measureText(head).width;
    g.fillStyle = "#fff";
    g.font = `${fs}px "Hiragino Sans", "Noto Sans JP", "IPAPGothic", sans-serif`;
    const place = placeNo ? `場所${placeNo}${placeLabel ? " " + placeLabel : ""}` : "";
    g.fillText([siteCode, place, fmtDateTime(takenAt)].filter(Boolean).join("　"), fs * 1.4 + headW, y);
    return canvasBlob(c, 0.88);
  }

  // ---------- お試しモード ----------

  const Demo = (() => {
    const KEY = "xop-demo-v1";
    const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    const today = new Date();
    const day = (n) => isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));

    function seed() {
      const a1 = uid(), a2 = uid();
      const yamada = uid(), sato = uid(), suzuki = uid(), hq = uid();
      return {
        seq: 15,
        who: yamada,
        agencies: [{ id: a1, name: "△△工業" }, { id: a2, name: "○○塗装" }],
        members: [
          { id: yamada, agency_id: a1, name: "山田 太郎", role: "agency", is_certified: true, linked: true, active: true },
          { id: sato, agency_id: a1, name: "佐藤 次郎", role: "agency", is_certified: false, linked: true, active: true },
          { id: suzuki, agency_id: a2, name: "鈴木 花子", role: "agency", is_certified: true, linked: true, active: true },
          { id: hq, agency_id: null, name: "本部 担当", role: "hq", is_certified: false, linked: true, active: true },
        ],
        sites: [
          { id: uid(), code: "T-0012", label: "○○マンション 共用廊下", agency_id: a1, kind: "crux", planned_date: day(0), material: "tile_concrete", estimated_area: 120, status: "planned" },
          { id: uid(), code: "T-0015", label: "□□様邸 玄関ポーチ", agency_id: a1, kind: "own", planned_date: day(3), material: "tile_concrete", estimated_area: 18, status: "planned" },
          { id: uid(), code: "T-0009", label: "△△ビル 外階段", agency_id: a1, kind: "own", planned_date: day(-2), material: "other", estimated_area: 40, status: "planned" },
          { id: uid(), code: "T-0014", label: "◇◇保育園 テラス", agency_id: a2, kind: "own", planned_date: day(1), material: "tile_concrete", estimated_area: 35, status: "planned" },
        ],
        reports: [],
        photos: [],
        attendance: [],
        events: [],
      };
    }

    let s;
    const load = () => {
      try {
        s = JSON.parse(localStorage.getItem(KEY) || "null");
      } catch {}
      if (!s) {
        s = seed();
        save();
      }
    };
    const save = () => localStorage.setItem(KEY, JSON.stringify(s));
    const err = (m) => Object.assign(new Error(m), { status: 400 });
    const meM = () => s.members.find((m) => m.id === s.who);
    const agencyOf = (id) => s.agencies.find((a) => a.id === id);
    const line = (to, text) => {
      const m = s.members.find((x) => x.id === to);
      setTimeout(() => toast(`📱 ${m ? m.name + "さん" : "本部"}のLINEに届くメッセージ\n${text}`, 6000), 300);
    };

    async function bundle(reportId) {
      const report = s.reports.find((r) => r.id === reportId);
      const photos = [];
      for (const p of s.photos.filter((x) => x.report_id === reportId)) {
        const blob = await idb.get("demo-file:" + p.storage_path);
        photos.push({ ...p, url: blob ? URL.createObjectURL(blob) : null });
      }
      photos.sort((a, b) => (a.kind + (a.place_no ?? 0)).localeCompare(b.kind + (b.place_no ?? 0)));
      return {
        report,
        photos,
        attendance: s.attendance.filter((x) => x.report_id === reportId),
        events: s.events.filter((x) => x.report_id === reportId),
      };
    }
    const withSite = (r) => {
      const site = s.sites.find((x) => x.id === r.site_id);
      return { ...r, sites: { ...site, agencies: { name: agencyOf(site.agency_id).name } } };
    };

    const actions = {
      me() {
        const m = meM();
        return { registered: true, member: m, agency: m.agency_id ? agencyOf(m.agency_id) : null };
      },
      my_sites() {
        const m = meM();
        const sites = s.sites
          .filter((x) => (m.role === "hq" || x.agency_id === m.agency_id) && ["planned", "reported"].includes(x.status))
          .map((x) => ({ ...x, report: s.reports.find((r) => r.site_id === x.id) || null }))
          .filter((x) => !x.report || x.report.status === "returned")
          .sort((a, b) => (a.planned_date || "").localeCompare(b.planned_date || ""));
        return { sites };
      },
      async site_detail({ site_id }) {
        const site = s.sites.find((x) => x.id === site_id);
        const people = s.members.filter((m) => m.agency_id === site.agency_id && m.role === "agency");
        const r = s.reports.find((x) => x.site_id === site_id);
        return { site, people, ...(r ? await bundle(r.id) : {}) };
      },
      site_by_code({ code }) {
        const site = s.sites.find((x) => x.code === String(code).trim().toUpperCase());
        if (!site) throw err("この現場は登録されていません");
        return { site_id: site.id };
      },
      photo_upload_url({ site_id }) {
        const site = s.sites.find((x) => x.id === site_id);
        const path = `${site.code}/${uid()}.jpg`;
        return { path, signed_url: "demo:" + path };
      },
      submit_report({ site_id, fields: f, photos, attendance }) {
        const m = meM();
        const site = s.sites.find((x) => x.id === site_id);
        const missing = XOP.reportMissing(site, f, photos, attendance);
        if (missing.length) throw err("足りない項目があります：" + missing.join("、"));
        let r = s.reports.find((x) => x.site_id === site_id);
        if (r && r.status !== "returned") throw err("この現場はすでに報告されています");
        const resub = !!r;
        const row = {
          site_id, submitted_by: m.id, start_date: f.start_date, end_date: f.end_date,
          responsible_member_id: f.responsible_member_id, material: f.material,
          area_m2: Number(f.area_m2), liters: Number(f.liters), cans: (f.cans || []).filter(Boolean),
          customer_confirmed: f.customer_confirmed ?? null, note: f.note || null,
          status: "submitted", hq_comment: null, submitted_at: new Date().toISOString(),
          reviewed_by: null, reviewed_at: null, certificate_issued_at: null,
        };
        if (r) Object.assign(r, row);
        else s.reports.push((r = { id: uid(), ...row }));
        s.photos = s.photos.filter((p) => p.report_id !== r.id).concat(photos.map((p) => ({ id: uid(), report_id: r.id, ...p })));
        s.attendance = s.attendance.filter((a) => a.report_id !== r.id);
        if (site.kind === "crux") s.attendance.push(...attendance.map((a) => ({ id: uid(), report_id: r.id, ...a, days: Number(a.days) })));
        site.status = "reported";
        s.events.push({ report_id: r.id, action: resub ? "resubmitted" : "submitted", actor: m.id, created_at: new Date().toISOString() });
        save();
        line(m.id, `✅ 完了報告を受け付けました\n${site.code} ${site.label}\n本部で確認して、2営業日以内にお知らせします。おつかれさまでした。`);
        return { report_id: r.id };
      },
      hq_list({ status }) {
        const st = status === "approved" ? "approved" : "submitted";
        return {
          reports: s.reports
            .filter((r) => r.status === st && (st === "submitted" || !r.certificate_issued_at))
            .map(withSite),
        };
      },
      async hq_detail({ report_id }) {
        const b = await bundle(report_id);
        const site = s.sites.find((x) => x.id === b.report.site_id);
        return {
          ...b,
          site: { ...site, agencies: { name: agencyOf(site.agency_id).name } },
          people: s.members.filter((m) => [b.report.responsible_member_id, b.report.submitted_by].includes(m.id)),
        };
      },
      hq_review({ report_id, decision, comment }) {
        const r = s.reports.find((x) => x.id === report_id);
        const site = s.sites.find((x) => x.id === r.site_id);
        if (decision === "return" && !String(comment || "").trim()) throw err("差し戻す理由を一言入れてください");
        const ok = decision === "approve";
        Object.assign(r, { status: ok ? "approved" : "returned", hq_comment: ok ? null : comment, reviewed_at: new Date().toISOString() });
        site.status = ok ? "approved" : "reported";
        s.events.push({ report_id, action: ok ? "approved" : "returned", comment, created_at: new Date().toISOString() });
        save();
        line(r.submitted_by, ok
          ? `🎉 確認できました\n${site.code} ${site.label}\n正規施工証明書を準備します。`
          : `✏ 直してほしいところがあります\n${site.code} ${site.label}\n${comment}`);
        return { ok: true };
      },
      hq_certify({ report_id }) {
        const r = s.reports.find((x) => x.id === report_id);
        const site = s.sites.find((x) => x.id === r.site_id);
        r.certificate_issued_at = new Date().toISOString();
        site.status = "certified";
        s.events.push({ report_id, action: "certified", created_at: r.certificate_issued_at });
        save();
        line(r.submitted_by, `📄 正規施工証明書ができました\n${site.code} ${site.label}\nお客様にお渡しください。`);
        return { ok: true };
      },
      hq_attendance({ month }) {
        return {
          rows: s.attendance
            .filter((a) => a.work_date.startsWith(month))
            .map((a) => ({ ...a, reports: withSite(s.reports.find((r) => r.id === a.report_id)) }))
            .sort((a, b) => a.work_date.localeCompare(b.work_date)),
        };
      },
      hq_masters() {
        return {
          agencies: s.agencies,
          members: s.members,
          sites: s.sites.map((x) => ({ ...x, agencies: { name: agencyOf(x.agency_id).name } })).reverse(),
        };
      },
      hq_create_agency({ name }) {
        if (!name) throw err("代理店名を入れてください");
        const a = { id: uid(), name };
        s.agencies.push(a);
        save();
        return { agency: a };
      },
      hq_create_member(b) {
        if (!b.name) throw err("名前を入れてください");
        const m = {
          id: uid(), agency_id: b.role === "hq" ? null : b.agency_id, name: b.name, role: b.role === "hq" ? "hq" : "agency",
          is_certified: !!b.is_certified, invite_code: Math.random().toString(36).slice(2, 8).toUpperCase(), linked: false, active: true,
        };
        s.members.push(m);
        save();
        return { member: m };
      },
      hq_create_site(b) {
        if (!b.label) throw err("現場の呼び名を入れてください");
        const site = {
          id: uid(), code: "T-" + String(++s.seq).padStart(4, "0"), label: b.label, agency_id: b.agency_id,
          kind: b.kind === "crux" ? "crux" : "own", planned_date: b.planned_date || null, material: b.material || "tile_concrete",
          estimated_area: b.estimated_area ? Number(b.estimated_area) : null, status: "planned",
        };
        s.sites.push(site);
        save();
        return { site };
      },
    };

    return {
      async call(action, args) {
        load();
        if (!actions[action]) throw err("不明な操作です");
        await new Promise((r) => setTimeout(r, 150));
        return JSON.parse(JSON.stringify(await actions[action](args || {})));
      },
      upload: (signedUrl, blob) => idb.put("demo-file:" + signedUrl.slice(5), blob),
      people() {
        load();
        return s.members.map((m) => ({ ...m, agency: m.agency_id ? agencyOf(m.agency_id).name : "本部" }));
      },
      who() {
        load();
        return s.who;
      },
      setWho(id) {
        load();
        s.who = id;
        save();
      },
      reset() {
        localStorage.removeItem(KEY);
      },
    };
  })();

  // ---------- LIFF と API ----------

  async function init({ asHq = false } = {}) {
    if (demo) {
      if (asHq) {
        const hq = Demo.people().find((m) => m.role === "hq");
        if (hq) Demo.setWho(hq.id);
      }
      return;
    }
    await liff.init({ liffId: cfg.liffId });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      await new Promise(() => {}); // ログイン画面へ移るまで待つ
    }
  }

  async function idToken() {
    const decoded = liff.getDecodedIDToken();
    if (!decoded || decoded.exp * 1000 < Date.now() + 30000) {
      liff.logout();
      liff.login({ redirectUri: location.href });
      await new Promise(() => {});
    }
    return liff.getIDToken();
  }

  async function call(action, args = {}) {
    if (demo) return Demo.call(action, args);
    const res = await fetch(cfg.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-line-id-token": await idToken() },
      body: JSON.stringify({ action, ...args }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || "通信に失敗しました"), { status: res.status });
    return body;
  }

  async function upload(signedUrl, blob) {
    if (demo) return Demo.upload(signedUrl, blob);
    const res = await fetch(signedUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "x-upsert": "false" },
      body: blob,
    });
    if (!res.ok) throw new Error("写真を送れませんでした");
  }

  // 送る前の必須チェック（サーバーでも同じチェックをする）
  function reportMissing(site, f, photos, attendance) {
    const out = [];
    if (!f.start_date || !f.end_date) out.push("施工日");
    if (!f.responsible_member_id) out.push("施工責任者");
    if (!(Number(f.area_m2) > 0)) out.push("施工した面積");
    if (!(Number(f.liters) > 0)) out.push("使ったXOPの量");
    if (!(f.cans || []).some((c) => String(c).trim()) && !photos.some((p) => p.kind === "can_label")) out.push("使った缶");
    if (photos.filter((p) => p.kind === "before").length < 2) out.push("施工前の写真（2枚以上）");
    if (photos.filter((p) => p.kind === "after").length < 2) out.push("施工後の写真（2枚以上）");
    if (site.kind === "crux" && !(attendance || []).length) out.push("出面");
    return out;
  }

  function demoBanner({ hq = false } = {}) {
    if (!demo) return;
    const bar = document.createElement("div");
    bar.className = "demo-bar";
    const people = Demo.people().filter((m) => (hq ? m.role === "hq" : m.role === "agency"));
    bar.innerHTML = `<b>お試しモード</b>　データはこのブラウザの中だけに保存されます。
      ${hq ? "" : `<label>使う人：<select id="demo-who">${people.map((m) => `<option value="${m.id}" ${m.id === Demo.who() ? "selected" : ""}>${esc(m.agency)} ${esc(m.name)}</option>`).join("")}</select></label>`}
      <a href="${hq ? "index.html" : "hq.html"}${location.search}">${hq ? "代理店の画面へ" : "本部の画面へ"}</a>
      <button type="button" id="demo-reset">最初からやり直す</button>`;
    document.body.prepend(bar);
    $("#demo-who", bar)?.addEventListener("change", (e) => {
      Demo.setWho(e.target.value);
      location.reload();
    });
    $("#demo-reset", bar).addEventListener("click", () => {
      if (confirm("お試しのデータを消して最初からやり直しますか？")) {
        Demo.reset();
        location.reload();
      }
    });
  }

  window.XOP = {
    demo, params, init, call, upload, reportMissing, demoBanner,
    readExifDate, resizePhoto, stampPhoto, idb, drafts, toast,
    $, esc, fmtDate, fmtDay, fmtDateTime, isoDate,
    KIND_LABEL, MATERIAL_LABEL, PHOTO_LABEL, COVERAGE_M2_PER_L,
  };
})();
