// LINE とのやりとり（IDトークンの確認、プッシュメッセージ）

const LOGIN_CHANNEL_ID = Deno.env.get("LINE_LOGIN_CHANNEL_ID") ?? "";
const MESSAGING_TOKEN = Deno.env.get("LINE_MESSAGING_TOKEN") ?? "";

export interface LineProfile {
  userId: string;
  name?: string;
}

const cache = new Map<string, { profile: LineProfile; exp: number }>();

/** LIFF の IDトークンを LINE に確認してもらい、LINEのユーザーIDを返す。 */
export async function verifyIdToken(idToken: string): Promise<LineProfile | null> {
  const hit = cache.get(idToken);
  if (hit && hit.exp > Date.now()) return hit.profile;

  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: LOGIN_CHANNEL_ID }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  if (!body.sub) return null;

  const profile = { userId: body.sub as string, name: body.name as string | undefined };
  const exp = Math.min((body.exp as number) * 1000, Date.now() + 10 * 60 * 1000);
  cache.set(idToken, { profile, exp });
  return profile;
}

/** 公式アカウントから個人にメッセージを送る。失敗しても報告の処理は止めない。 */
export async function pushText(to: string | null | undefined, text: string): Promise<void> {
  if (!to || !MESSAGING_TOKEN) return;
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MESSAGING_TOKEN}`,
      },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
    if (!res.ok) console.error("LINE push failed", res.status, await res.text());
  } catch (e) {
    console.error("LINE push error", e);
  }
}
