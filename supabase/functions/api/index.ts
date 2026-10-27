// 施工完了のLINE報告 API（Supabase Edge Function）
//
// ブラウザ（LIFF）は LINE の IDトークンを x-line-id-token ヘッダーで送る。
// ここで LINE に確認してから、サービスロールでデータベースを読み書きする。
// 呼び方: POST /functions/v1/api  { "action": "...", ...引数 }

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { pushText, verifyIdToken } from "../_shared/line.ts";

const BUCKET = "report-photos";
const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");

const db: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "content-type, x-line-id-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

// supabase-js の結果からデータを取り出す（型はここでは細かく付けない）
function must(res: { data: unknown; error: unknown }): any {
  if (res.error) {
    console.error(res.error);
    throw new HttpError(500, "データベースの処理に失敗しました");
  }
  return res.data;
}

interface Member {
  id: string;
  agency_id: string | null;
  name: string;
  role: "agency" | "hq";
  is_certified: boolean;
  line_user_id: string | null;
}

type Ctx = { lineUserId: string; member: Member | null; body: Record<string, any> };

// ---------- 共通 ----------

function requireMember(ctx: Ctx): Member {
  if (!ctx.member) throw new HttpError(403, "まだ登録されていません");
  return ctx.member;
}

function requireHq(ctx: Ctx): Member {
  const m = requireMember(ctx);
  if (m.role !== "hq") throw new HttpError(403, "本部の人だけが使えます");
  return m;
}

async function loadSiteForAgency(member: Member, siteId: string) {
  const site = must(await db.from("sites").select("*").eq("id", siteId).maybeSingle());
  if (!site || (member.role !== "hq" && site.agency_id !== member.agency_id)) {
    throw new HttpError(404, "現場が見つかりません");
  }
  return site;
}

async function signedUrls(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const data = must(await db.storage.from(BUCKET).createSignedUrls(paths, 60 * 60));
  const out: Record<string, string> = {};
  for (const d of data as { path: string | null; signedUrl: string }[]) {
    if (d.path) out[d.path] = d.signedUrl;
  }
  return out;
}

async function reportBundle(reportId: string) {
  const report = must(await db.from("reports").select("*").eq("id", reportId).single());
  const photos = must(await db.from("report_photos").select("*").eq("report_id", reportId)
    .order("kind").order("place_no").order("created_at")) as any[];
  const attendance = must(await db.from("attendance").select("*").eq("report_id", reportId)
    .order("work_date").order("person_name"));
  const events = must(await db.from("report_events").select("*").eq("report_id", reportId)
    .order("created_at"));
  const urls = await signedUrls(photos.map((p) => p.storage_path));
  for (const p of photos) p.url = urls[p.storage_path] ?? null;
  return { report, photos, attendance, events };
}

async function hqLineIds(): Promise<string[]> {
  const rows = must(await db.from("members").select("line_user_id")
    .eq("role", "hq").eq("active", true).not("line_user_id", "is", null)) as any[];
  return rows.map((r) => r.line_user_id);
}

const INVITE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => INVITE_CHARS[b % INVITE_CHARS.length]).join("");
}

// ---------- 代理店の画面 ----------

async function me(ctx: Ctx) {
  if (!ctx.member) return { registered: false };
  const agency = ctx.member.agency_id
    ? must(await db.from("agencies").select("id, name").eq("id", ctx.member.agency_id).single())
    : null;
  return { registered: true, member: ctx.member, agency };
}

async function register(ctx: Ctx) {
  if (ctx.member) return me(ctx);
  const code = String(ctx.body.invite_code ?? "").trim().toUpperCase();
  if (!code) throw new HttpError(400, "招待コードを入れてください");
  const found = must(await db.from("members").select("*").eq("invite_code", code)
    .is("line_user_id", null).eq("active", true).maybeSingle()) as Member | null;
  if (!found) throw new HttpError(404, "招待コードが違うか、すでに使われています");
  ctx.member = must(await db.from("members")
    .update({ line_user_id: ctx.lineUserId, invite_code: null })
    .eq("id", found.id).select("*").single());
  return me(ctx);
}

async function mySites(ctx: Ctx) {
  const m = requireMember(ctx);
  let q = db.from("sites").select("*, reports(id, status, hq_comment)")
    .in("status", ["planned", "reported"]).order("planned_date", { nullsFirst: false });
  if (m.role !== "hq") q = q.eq("agency_id", m.agency_id!);
  const rows = must(await q) as any[];
  // 報告前、または差し戻された現場だけを出す
  return {
    sites: rows
      .map((s) => ({ ...s, report: (Array.isArray(s.reports) ? s.reports[0] : s.reports) ?? null }))
      .filter((s) => !s.report || s.report.status === "returned")
      .map(({ reports: _r, ...s }) => s),
  };
}

async function siteDetail(ctx: Ctx) {
  const m = requireMember(ctx);
  const site = await loadSiteForAgency(m, ctx.body.site_id);
  const people = must(await db.from("members").select("id, name, is_certified")
    .eq("agency_id", site.agency_id).eq("role", "agency").eq("active", true).order("name"));
  const existing = must(await db.from("reports").select("id").eq("site_id", site.id).maybeSingle()) as any;
  const bundle = existing ? await reportBundle(existing.id) : null;
  return { site, people, ...(bundle ?? {}) };
}

async function siteByCode(ctx: Ctx) {
  const m = requireMember(ctx);
  const code = String(ctx.body.code ?? "").trim().toUpperCase();
  const site = must(await db.from("sites").select("id, agency_id").eq("code", code).maybeSingle()) as any;
  if (!site || (m.role !== "hq" && site.agency_id !== m.agency_id)) {
    throw new HttpError(404, "この現場はあなたの担当ではないか、登録されていません");
  }
  return { site_id: site.id };
}

async function photoUploadUrl(ctx: Ctx) {
  const m = requireMember(ctx);
  const site = await loadSiteForAgency(m, ctx.body.site_id);
  const path = `${site.code}/${crypto.randomUUID()}.jpg`;
  const data = must(await db.storage.from(BUCKET).createSignedUploadUrl(path)) as any;
  return { path, signed_url: data.signedUrl };
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));

async function submitReport(ctx: Ctx) {
  const m = requireMember(ctx);
  const site = await loadSiteForAgency(m, ctx.body.site_id);
  const f = ctx.body.fields ?? {};
  const photos = (ctx.body.photos ?? []) as any[];
  const attendance = (ctx.body.attendance ?? []) as any[];

  // 必須のチェック（画面でも同じチェックをしている）
  const errors: string[] = [];
  if (!f.start_date || !f.end_date) errors.push("施工日");
  if (!f.responsible_member_id) errors.push("施工責任者");
  if (!(num(f.area_m2) > 0)) errors.push("施工した面積");
  if (!(num(f.liters) > 0)) errors.push("使ったXOPの量");
  const cans = ((f.cans ?? []) as string[]).map((c) => String(c).trim()).filter(Boolean);
  if (cans.length === 0 && !photos.some((p) => p.kind === "can_label")) errors.push("使った缶");
  if (photos.filter((p) => p.kind === "before").length < 2) errors.push("施工前の写真（2枚以上）");
  if (photos.filter((p) => p.kind === "after").length < 2) errors.push("施工後の写真（2枚以上）");
  if (site.kind === "crux" && attendance.length === 0) errors.push("出面");
  if (errors.length) throw new HttpError(400, "足りない項目があります：" + errors.join("、"));

  for (const p of photos) {
    if (typeof p.storage_path !== "string" || !p.storage_path.startsWith(`${site.code}/`)) {
      throw new HttpError(400, "写真の保存場所が正しくありません");
    }
  }
  const responsible = must(await db.from("members").select("id, agency_id")
    .eq("id", f.responsible_member_id).maybeSingle()) as any;
  if (!responsible || responsible.agency_id !== site.agency_id) {
    throw new HttpError(400, "施工責任者が正しくありません");
  }

  const prev = must(await db.from("reports").select("id, status").eq("site_id", site.id).maybeSingle()) as any;
  if (prev && prev.status !== "returned") throw new HttpError(409, "この現場はすでに報告されています");

  const row = {
    site_id: site.id,
    submitted_by: m.id,
    start_date: f.start_date,
    end_date: f.end_date,
    responsible_member_id: f.responsible_member_id,
    material: f.material === "other" ? "other" : "tile_concrete",
    area_m2: num(f.area_m2),
    liters: num(f.liters),
    cans,
    customer_confirmed: f.customer_confirmed === null || f.customer_confirmed === undefined
      ? null
      : Boolean(f.customer_confirmed),
    note: f.note ? String(f.note).slice(0, 1000) : null,
    status: "submitted",
    hq_comment: null,
    submitted_at: new Date().toISOString(),
    reviewed_by: null,
    reviewed_at: null,
  };
  const report = prev
    ? must(await db.from("reports").update(row).eq("id", prev.id).select("id").single()) as any
    : must(await db.from("reports").insert(row).select("id").single()) as any;

  // 写真と出面は送られてきたもので置きかえる。外された写真は保管場所からも消す。
  const oldPhotos = must(await db.from("report_photos").select("storage_path").eq("report_id", report.id)) as any[];
  const keep = new Set(photos.map((p) => p.storage_path));
  const removed = oldPhotos.map((p) => p.storage_path).filter((p) => !keep.has(p));
  must(await db.from("report_photos").delete().eq("report_id", report.id));
  must(await db.from("report_photos").insert(photos.map((p) => ({
    report_id: report.id,
    kind: p.kind,
    place_no: p.place_no ?? null,
    place_label: p.place_label ? String(p.place_label).slice(0, 40) : null,
    storage_path: p.storage_path,
    taken_at: p.taken_at ?? null,
    source: p.source === "camera" ? "camera" : "library",
  }))));
  if (removed.length) await db.storage.from(BUCKET).remove(removed);

  must(await db.from("attendance").delete().eq("report_id", report.id));
  if (site.kind === "crux") {
    must(await db.from("attendance").insert(attendance.map((a) => ({
      report_id: report.id,
      person_name: String(a.person_name).slice(0, 40),
      person_role: a.person_role === "responsible" ? "responsible" : "helper",
      work_date: a.work_date,
      days: Number(a.days) === 0.5 ? 0.5 : 1,
    }))));
  }

  must(await db.from("sites").update({ status: "reported" }).eq("id", site.id));
  must(await db.from("report_events").insert({
    report_id: report.id,
    action: prev ? "resubmitted" : "submitted",
    actor: m.id,
  }));

  const agency = must(await db.from("agencies").select("name").eq("id", site.agency_id).single()) as any;
  await pushText(
    m.line_user_id,
    `✅ 完了報告を受け付けました\n${site.code} ${site.label}\n本部で確認して、2営業日以内にお知らせします。おつかれさまでした。`,
  );
  const hqText = `${agency.name}から完了報告${prev ? "（再送）" : ""}（${site.code}）\n${site.label}` +
    (APP_URL ? `\n${APP_URL}/hq.html?report=${report.id}` : "");
  for (const id of await hqLineIds()) await pushText(id, hqText);

  return { report_id: report.id };
}

// ---------- 本部の画面 ----------

async function hqList(ctx: Ctx) {
  requireHq(ctx);
  const status = ctx.body.status === "approved" ? "approved" : "submitted";
  let q = db.from("reports")
    .select("id, status, submitted_at, reviewed_at, certificate_issued_at, area_m2, liters, sites(id, code, label, kind, agency_id, agencies(name))")
    .eq("status", status).order("submitted_at");
  if (status === "approved") q = q.is("certificate_issued_at", null);
  return { reports: must(await q) };
}

async function hqDetail(ctx: Ctx) {
  requireHq(ctx);
  const bundle = await reportBundle(ctx.body.report_id);
  const site = must(await db.from("sites").select("*, agencies(name)").eq("id", bundle.report.site_id).single());
  const ids = [bundle.report.responsible_member_id, bundle.report.submitted_by];
  const people = must(await db.from("members").select("id, name, is_certified").in("id", ids));
  return { ...bundle, site, people };
}

async function hqReview(ctx: Ctx) {
  const hq = requireHq(ctx);
  const decision = ctx.body.decision;
  const comment = String(ctx.body.comment ?? "").trim();
  if (decision !== "approve" && decision !== "return") throw new HttpError(400, "OKか差し戻しを選んでください");
  if (decision === "return" && !comment) throw new HttpError(400, "差し戻す理由を一言入れてください");

  const report = must(await db.from("reports").select("*, sites(*)").eq("id", ctx.body.report_id).single()) as any;
  if (report.status !== "submitted") throw new HttpError(409, "この報告はすでに確認済みです");

  const approve = decision === "approve";
  must(await db.from("reports").update({
    status: approve ? "approved" : "returned",
    hq_comment: approve ? null : comment,
    reviewed_by: hq.id,
    reviewed_at: new Date().toISOString(),
  }).eq("id", report.id));
  must(await db.from("sites").update({ status: approve ? "approved" : "reported" }).eq("id", report.site_id));
  must(await db.from("report_events").insert({
    report_id: report.id,
    action: approve ? "approved" : "returned",
    actor: hq.id,
    comment: comment || null,
  }));

  const submitter = must(await db.from("members").select("line_user_id").eq("id", report.submitted_by).single()) as any;
  const s = report.sites;
  await pushText(
    submitter.line_user_id,
    approve
      ? `🎉 確認できました\n${s.code} ${s.label}\n正規施工証明書を準備します。できあがったらお知らせしますので、お客様にお渡しください。`
      : `✏ 直してほしいところがあります\n${s.code} ${s.label}\n${comment}\nメニューの「施工完了報告」から直して、もう一度送ってください。`,
  );
  return { ok: true };
}

async function hqCertify(ctx: Ctx) {
  const hq = requireHq(ctx);
  const report = must(await db.from("reports").select("*, sites(*)").eq("id", ctx.body.report_id).single()) as any;
  if (report.status !== "approved") throw new HttpError(409, "OKになった報告だけが対象です");
  must(await db.from("reports").update({ certificate_issued_at: new Date().toISOString() }).eq("id", report.id));
  must(await db.from("sites").update({ status: "certified" }).eq("id", report.site_id));
  must(await db.from("report_events").insert({ report_id: report.id, action: "certified", actor: hq.id }));
  const submitter = must(await db.from("members").select("line_user_id").eq("id", report.submitted_by).single()) as any;
  await pushText(
    submitter.line_user_id,
    `📄 正規施工証明書ができました\n${report.sites.code} ${report.sites.label}\nお客様にお渡しください。`,
  );
  return { ok: true };
}

async function hqAttendance(ctx: Ctx) {
  requireHq(ctx);
  const month = String(ctx.body.month ?? "");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "月を選んでください");
  const [y, mo] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
  const rows = must(await db.from("attendance")
    .select("person_name, person_role, work_date, days, reports!inner(status, sites!inner(code, label, agencies(name)))")
    .gte("work_date", from).lt("work_date", to)
    .order("work_date"));
  return { rows };
}

async function hqMasters(ctx: Ctx) {
  requireHq(ctx);
  const agencies = must(await db.from("agencies").select("*").order("name"));
  const members = must(await db.from("members")
    .select("id, agency_id, name, role, is_certified, invite_code, active, line_user_id").order("created_at"));
  const sites = must(await db.from("sites").select("*, agencies(name)").order("created_at", { ascending: false }).limit(100));
  return {
    agencies,
    members: (members as any[]).map(({ line_user_id, ...m }) => ({ ...m, linked: !!line_user_id })),
    sites,
  };
}

async function hqCreateAgency(ctx: Ctx) {
  requireHq(ctx);
  const name = String(ctx.body.name ?? "").trim();
  if (!name) throw new HttpError(400, "代理店名を入れてください");
  return { agency: must(await db.from("agencies").insert({ name }).select("*").single()) };
}

async function hqCreateMember(ctx: Ctx) {
  requireHq(ctx);
  const b = ctx.body;
  const name = String(b.name ?? "").trim();
  const role = b.role === "hq" ? "hq" : "agency";
  if (!name) throw new HttpError(400, "名前を入れてください");
  if (role === "agency" && !b.agency_id) throw new HttpError(400, "代理店を選んでください");
  const member = must(await db.from("members").insert({
    name,
    role,
    agency_id: role === "agency" ? b.agency_id : null,
    is_certified: role === "agency" && !!b.is_certified,
    invite_code: newInviteCode(),
  }).select("*").single());
  return { member };
}

async function hqCreateSite(ctx: Ctx) {
  const hq = requireHq(ctx);
  const b = ctx.body;
  const label = String(b.label ?? "").trim();
  if (!label) throw new HttpError(400, "現場の呼び名を入れてください");
  if (!b.agency_id) throw new HttpError(400, "代理店を選んでください");
  const site = must(await db.from("sites").insert({
    label: label.slice(0, 60),
    agency_id: b.agency_id,
    kind: b.kind === "crux" ? "crux" : "own",
    planned_date: b.planned_date || null,
    material: b.material === "other" ? "other" : "tile_concrete",
    estimated_area: b.estimated_area ? Number(b.estimated_area) : null,
    created_by: hq.id,
  }).select("*").single());
  return { site };
}

const actions: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  me,
  register,
  my_sites: mySites,
  site_detail: siteDetail,
  site_by_code: siteByCode,
  photo_upload_url: photoUploadUrl,
  submit_report: submitReport,
  hq_list: hqList,
  hq_detail: hqDetail,
  hq_review: hqReview,
  hq_certify: hqCertify,
  hq_attendance: hqAttendance,
  hq_masters: hqMasters,
  hq_create_agency: hqCreateAgency,
  hq_create_member: hqCreateMember,
  hq_create_site: hqCreateSite,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const idToken = req.headers.get("x-line-id-token");
    if (!idToken) throw new HttpError(401, "LINEでログインしてください");
    const profile = await verifyIdToken(idToken);
    if (!profile) throw new HttpError(401, "LINEのログインが切れました。開き直してください");

    const body = await req.json().catch(() => ({}));
    const fn = actions[body.action];
    if (!fn) throw new HttpError(400, "不明な操作です");

    const member = must(await db.from("members").select("id, agency_id, name, role, is_certified, line_user_id")
      .eq("line_user_id", profile.userId).eq("active", true).maybeSingle()) as Member | null;

    return json(await fn({ lineUserId: profile.userId, member, body }));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "サーバーでエラーが起きました" }, 500);
  }
});
