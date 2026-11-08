/* Ironlog push — schedules a lock-screen "rest over" notification.
   POST /schedule {sub, at, label?}  -> push fires at `at` (ms epoch)
   POST /cancel   {sub}
   POST /test     {sub}              -> push in ~3 s
   GET  /vapid                       -> public key the app subscribes with
   Keys are generated once and kept in a Durable Object, so there are no secrets to set up. */

const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_AHEAD_MS = 30 * 60 * 1000;

const enc = new TextEncoder();
const b64u = buf => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (obj, env, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors(env) } });

function validSub(sub, env) {
  if (!sub || typeof sub.endpoint !== "string") return false;
  let u; try { u = new URL(sub.endpoint); } catch { return false; }
  if (env.DEV_ALLOW_ANY_ENDPOINT === "1") return true;
  return u.protocol === "https:" && PUSH_HOSTS.some(r => r.test(u.hostname));
}

const keysStub = env => env.KEYS.get(env.KEYS.idFromName("vapid"));

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && path === "/") return json({ ok: true, service: "ironlog-push" }, env);
    if (req.method === "GET" && path === "/vapid") {
      const r = await keysStub(env).fetch("https://do/public");
      return json(await r.json(), env);
    }
    if (req.method !== "POST") return json({ error: "method" }, env, 405);

    let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, env, 400); }
    const sub = body.sub;
    if (!validSub(sub, env)) return json({ error: "bad subscription" }, env, 400);
    const stub = env.TIMER.get(env.TIMER.idFromName(sub.endpoint));
    const now = Date.now();

    if (path === "/schedule" || path === "/test") {
      const at = path === "/test" ? now + 3000 : Number(body.at);
      if (!Number.isFinite(at) || at < now - 5000 || at > now + MAX_AHEAD_MS)
        return json({ error: "bad time" }, env, 400);
      await stub.fetch("https://do/schedule", { method: "POST", body: JSON.stringify({ sub, at: Math.max(at, now + 500) }) });
      return json({ ok: true, at }, env);
    }
    if (path === "/cancel") {
      await stub.fetch("https://do/cancel", { method: "POST", body: "{}" });
      return json({ ok: true }, env);
    }
    return json({ error: "not found" }, env, 404);
  },
};

/* One instance holds the VAPID key pair. */
export class VapidKeys {
  constructor(state) { this.state = state; }
  async keys() {
    let k = await this.state.storage.get("keys");
    if (!k) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
      const pub = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
      k = { priv: { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d }, pub };
      await this.state.storage.put("keys", k);
    }
    return k;
  }
  async fetch(req) {
    const k = await this.keys();
    const path = new URL(req.url).pathname;
    if (path === "/public") return Response.json({ publicKey: k.pub });
    if (path === "/private") return Response.json(k);
    return new Response("not found", { status: 404 });
  }
}

/* One instance per phone subscription; its alarm is the rest timer. */
export class RestTimer {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.json();
    if (path === "/schedule") {
      await this.state.storage.put("sub", body.sub);
      await this.state.storage.setAlarm(body.at);
      return new Response("ok");
    }
    if (path === "/cancel") { await this.state.storage.deleteAlarm(); return new Response("ok"); }
    return new Response("not found", { status: 404 });
  }
  async alarm() {
    const sub = await this.state.storage.get("sub");
    if (!sub) return;
    try {
      const res = await sendPush(sub, this.env);
      // 404/410: phone unsubscribed — forget it.
      if (res.status === 404 || res.status === 410) await this.state.storage.deleteAll();
      if (this.env.DEV_LOG === "1") console.log("push status", res.status);
    } catch (e) {
      console.log("push failed", String(e)); // a late rest alert is useless, so no retry
    }
  }
}

async function vapidAuth(endpoint, env) {
  const r = await keysStub(env).fetch("https://do/private");
  const { priv, pub } = await r.json();
  const key = await crypto.subtle.importKey("jwk", priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:ironlog@example.invalid",
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${pub}`;
}

/* Payload-less push: the service worker reads the label it saved itself. */
async function sendPush(sub, env) {
  return fetch(sub.endpoint, {
    method: "POST",
    headers: { Authorization: await vapidAuth(sub.endpoint, env), TTL: "120", Urgency: "high", "Content-Length": "0" },
  });
}
