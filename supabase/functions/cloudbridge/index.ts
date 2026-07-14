import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const PROJECT_REF = "ajlkfzgpheegmwsnspxw";
const APP_NAME = "Cloud Clipboard & File Bridge";
const BUCKET = Deno.env.get("SUPABASE_STORAGE_BUCKET") ?? "cloudbridge-files";
const FILE_TTL_SECONDS = Number(Deno.env.get("CLOUD_BRIDGE_FILE_TTL_SECONDS") ?? "86400");
const PAIRING_TTL_SECONDS = Number(Deno.env.get("CLOUD_BRIDGE_PAIRING_TTL_SECONDS") ?? "600");
const DELETE_AFTER_ACK = (Deno.env.get("CLOUD_BRIDGE_DELETE_AFTER_ACK") ?? "true").toLowerCase() === "true";
const PUBLIC_BASE_URL =
  Deno.env.get("CLOUD_BRIDGE_PUBLIC_URL") ??
  `https://${PROJECT_REF}.supabase.co/functions/v1/cloudbridge`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

type AuthContext = { kind: "admin" | "device"; token: string; device_id?: string };

function getSecretKey(): string {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (parsed.default) return parsed.default;
    } catch {
      // Fall through to legacy key.
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Missing Supabase secret key in Edge Function environment");
  return legacy;
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getSecretKey(), {
  auth: { persistSession: false },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType },
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function randomToken(bytes = 32): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

async function requireAuth(req: Request): Promise<AuthContext | Response> {
  const token = bearerToken(req);
  if (!token) return json({ detail: "Invalid or missing bearer token" }, 401);
  const tokenHash = await sha256(token);

  const { data: adminRows, error: adminError } = await supabase
    .from("cloudbridge_admin_tokens")
    .select("label")
    .eq("token_hash", tokenHash)
    .eq("revoked", false)
    .limit(1);
  if (adminError) return json({ detail: adminError.message }, 500);
  if (adminRows?.length) return { kind: "admin", token };

  const { data: deviceRows, error: deviceError } = await supabase
    .from("cloudbridge_devices")
    .select("device_id")
    .eq("token_hash", tokenHash)
    .eq("revoked", false)
    .limit(1);
  if (deviceError) return json({ detail: deviceError.message }, 500);
  if (deviceRows?.length) return { kind: "device", token, device_id: deviceRows[0].device_id };

  return json({ detail: "Invalid token" }, 401);
}

function safeFilename(name: string): string {
  const cleaned = name.split(/[\\/]/).pop()?.replaceAll("\0", "").trim() || "upload.bin";
  return cleaned.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || "upload.bin";
}

function publicFileRecord(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.storage_path;
  return copy;
}

function normalizePath(url: URL): string {
  const path = url.pathname || "/";
  const prefixes = ["/functions/v1/cloudbridge", "/cloudbridge"];
  for (const prefix of prefixes) {
    if (path === prefix) return "/";
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length) || "/";
  }
  return path;
}

const PWA_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#101820">
  <link rel="manifest" href="./manifest.json">
  <title>CloudBridge</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #101820; color: #f4f7fb; }
    main { max-width: 720px; margin: 0 auto; padding: 22px 16px 42px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:18px; }
    h1 { font-size: 24px; margin: 0; letter-spacing: 0; }
    .pill { border:1px solid #375066; border-radius:999px; padding:7px 10px; color:#a8c7dd; font-size:13px; }
    section { border-top: 1px solid #2d4052; padding-top: 18px; margin-top: 18px; }
    label { display: block; margin: 14px 0 8px; font-weight: 700; }
    input, textarea, button { width: 100%; box-sizing: border-box; border: 1px solid #36536a; border-radius: 8px; background: #152332; color: #f8fafc; font: inherit; }
    input, textarea { padding: 12px; }
    textarea { min-height: 150px; resize: vertical; }
    button { margin-top: 10px; padding: 13px 14px; border: 0; background: #5eead4; color: #042f2e; font-weight: 850; }
    button.secondary { background: #284156; color: #f8fafc; }
    button.danger { background: #fca5a5; color: #450a0a; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .status { margin-top: 16px; padding: 12px; border-radius: 8px; background: #172a3a; color: #cbd5e1; min-height: 24px; }
    .muted { color: #9fb4c6; line-height: 1.5; }
    .hidden { display:none; }
  </style>
</head>
<body>
<main>
  <header><h1>CloudBridge</h1><div id="pairState" class="pill">Checking</div></header>
  <section id="pairPanel" class="hidden">
    <p class="muted">Pair this iPhone from the Windows tray app. Scan or open the pairing link, then tap Pair.</p>
    <label for="pairCode">Pairing code</label>
    <input id="pairCode" autocomplete="one-time-code" placeholder="Pairing code">
    <button id="pairBtn">Pair iPhone</button>
  </section>
  <section id="appPanel" class="hidden">
    <label for="content">Text</label>
    <textarea id="content" placeholder="Paste text here, or pull latest text from PC."></textarea>
    <div class="row"><button id="pasteBtn" class="secondary">Paste</button><button id="copyBtn" class="secondary">Copy</button></div>
    <button id="pushBtn">Push to PC</button>
    <button id="pullBtn" class="secondary">Pull from PC</button>
    <label for="file">File</label>
    <input id="file" type="file">
    <button id="fileBtn">Send File to PC</button>
    <button id="resetBtn" class="danger">Forget Pairing</button>
  </section>
  <div id="status" class="status">Ready.</div>
</main>
<script>
const base = location.pathname.replace(/\\/(app|manifest\\.json|icon\\.svg|sw\\.js).*$/, "");
const deviceId = localStorage.getItem("cloudbridge_device_id") || ("ios-" + Math.random().toString(36).slice(2));
localStorage.setItem("cloudbridge_device_id", deviceId);
const params = new URLSearchParams(location.search);
const pairCodeInput = document.getElementById("pairCode");
if (params.get("code")) pairCodeInput.value = params.get("code");
const statusBox = document.getElementById("status");
const pairState = document.getElementById("pairState");
const pairPanel = document.getElementById("pairPanel");
const appPanel = document.getElementById("appPanel");
const content = document.getElementById("content");
function token() { return localStorage.getItem("cloudbridge_token") || ""; }
function status(message) { statusBox.textContent = message; }
function headers(extra = {}) { return { "Authorization": "Bearer " + token(), ...extra }; }
function setPaired(isPaired) { pairState.textContent = isPaired ? "Paired" : "Not paired"; pairPanel.classList.toggle("hidden", isPaired); appPanel.classList.toggle("hidden", !isPaired); }
async function checkPairing() { if (!token()) { setPaired(false); return; } const response = await fetch(base + "/api/me", { headers: headers() }); setPaired(response.ok); if (!response.ok) localStorage.removeItem("cloudbridge_token"); }
document.getElementById("pairBtn").onclick = async () => { try { const response = await fetch(base + "/api/pairing/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pairCodeInput.value.trim(), device_id: deviceId, label: "iPhone" }) }); if (!response.ok) throw new Error(await response.text()); const data = await response.json(); localStorage.setItem("cloudbridge_token", data.token); setPaired(true); status("iPhone paired."); } catch (err) { status("Pairing failed: " + err.message); } };
document.getElementById("pasteBtn").onclick = async () => { try { content.value = await navigator.clipboard.readText(); status("Pasted from iPhone clipboard."); } catch { status("Paste blocked by iOS. Paste manually into the text box."); } };
document.getElementById("copyBtn").onclick = async () => { try { await navigator.clipboard.writeText(content.value); status("Copied to iPhone clipboard."); } catch { status("Copy blocked by iOS. Select text manually."); } };
document.getElementById("pushBtn").onclick = async () => { try { const response = await fetch(base + "/api/clipboard/push", { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify({ content: content.value, source: "ios-pwa", device_id: deviceId }) }); if (!response.ok) throw new Error(await response.text()); status("Sent to PC. Press Ctrl+V on Windows."); } catch (err) { status("Push failed: " + err.message); } };
document.getElementById("pullBtn").onclick = async () => { try { const response = await fetch(base + "/api/clipboard/latest?device_id=" + encodeURIComponent(deviceId), { headers: headers() }); if (!response.ok) throw new Error(await response.text()); const data = await response.json(); if (!data.has_update) { status("No new clipboard from PC."); return; } content.value = data.item.content; try { await navigator.clipboard.writeText(data.item.content); status("Pulled from PC and copied to iPhone clipboard."); } catch { status("Pulled from PC. Use Copy if iOS did not allow clipboard write."); } } catch (err) { status("Pull failed: " + err.message); } };
document.getElementById("fileBtn").onclick = async () => { try { const input = document.getElementById("file"); if (!input.files.length) throw new Error("Choose a file first."); const form = new FormData(); form.append("file", input.files[0]); form.append("source", "ios-pwa"); form.append("device_id", deviceId); const response = await fetch(base + "/api/files/upload", { method: "POST", headers: headers(), body: form }); if (!response.ok) throw new Error(await response.text()); status("File sent. Windows Agent will download it."); } catch (err) { status("File send failed: " + err.message); } };
document.getElementById("resetBtn").onclick = () => { localStorage.removeItem("cloudbridge_token"); setPaired(false); status("Pairing removed from this iPhone."); };
if ("serviceWorker" in navigator) navigator.serviceWorker.register(base + "/sw.js").catch(() => {});
checkPairing().catch(() => setPaired(false));
</script>
</body>
</html>`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const path = normalizePath(url);

    if (req.method === "GET" && (path === "/" || path === "/app")) return text(PWA_HTML, 200, "text/html; charset=utf-8");
    if (req.method === "GET" && path === "/health") return json({ ok: "true", service: APP_NAME, mode: "supabase-edge" });
    if (req.method === "GET" && path === "/manifest.json") return json({ name: "CloudBridge", short_name: "CloudBridge", start_url: "./app", display: "standalone", background_color: "#101820", theme_color: "#101820", icons: [{ src: "./icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }] });
    if (req.method === "GET" && path === "/icon.svg") return text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#101820"/><path d="M156 178h200v156H156z" fill="#5eead4"/><path d="M196 138h120v52H196zM196 322h120v52H196z" fill="#f8fafc"/></svg>', 200, "image/svg+xml");
    if (req.method === "GET" && path === "/sw.js") return text("self.addEventListener('install',event=>self.skipWaiting());\nself.addEventListener('fetch',event=>{});\n", 200, "application/javascript");

    if (req.method === "POST" && path === "/api/pairing/claim") {
      const body = await req.json();
      const codeHash = await sha256(String(body.code ?? ""));
      const { data: sessions, error: sessionError } = await supabase.from("cloudbridge_pairing_sessions").select("*").eq("code_hash", codeHash).is("claimed_at", null).gt("expires_at", nowIso()).limit(1);
      if (sessionError) return json({ detail: sessionError.message }, 500);
      if (!sessions?.length) return json({ detail: "Pairing code is invalid or expired" }, 404);
      const token = randomToken(32);
      const tokenHash = await sha256(token);
      const deviceId = String(body.device_id ?? "");
      if (!deviceId) return json({ detail: "device_id is required" }, 422);
      const { error: deviceError } = await supabase.from("cloudbridge_devices").upsert({ device_id: deviceId, label: String(body.label ?? "iPhone"), platform: "ios", token_hash: tokenHash, revoked: false }, { onConflict: "device_id" });
      if (deviceError) return json({ detail: deviceError.message }, 500);
      const { error: updateError } = await supabase.from("cloudbridge_pairing_sessions").update({ claimed_by_device_id: deviceId, claimed_at: nowIso() }).eq("id", sessions[0].id);
      if (updateError) return json({ detail: updateError.message }, 500);
      return json({ ok: true, device_id: deviceId, token });
    }

    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;

    if (req.method === "GET" && path === "/api/me") return json({ ok: true, auth: auth.kind, device_id: auth.device_id ?? null });

    if (req.method === "POST" && path === "/api/pairing/create") {
      if (auth.kind !== "admin") return json({ detail: "Admin token required" }, 401);
      const body = await req.json();
      const code = randomToken(18);
      const row = { code_hash: await sha256(code), created_by_device_id: String(body.device_id ?? "windows"), created_by_label: String(body.label ?? "Windows PC"), expires_at: addSeconds(PAIRING_TTL_SECONDS) };
      const { data, error } = await supabase.from("cloudbridge_pairing_sessions").insert(row).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, code, pairing_url: `${PUBLIC_BASE_URL}/app?code=${encodeURIComponent(code)}`, expires_at: data.expires_at });
    }

    if (req.method === "POST" && path === "/api/clipboard/push") {
      const body = await req.json();
      if (!body.content || !body.device_id) return json({ detail: "content and device_id are required" }, 422);
      const { data, error } = await supabase.from("cloudbridge_clipboard").insert({ content: String(body.content), source: String(body.source ?? "unknown"), device_id: String(body.device_id) }).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, item: data });
    }

    if (req.method === "GET" && path === "/api/clipboard/latest") {
      const { data, error } = await supabase.from("cloudbridge_clipboard").select("*").order("version", { ascending: false }).limit(1);
      if (error) return json({ detail: error.message }, 500);
      const latest = data?.[0];
      if (!latest) return json({ ok: true, has_update: false, item: null });
      if (url.searchParams.get("since_id") === latest.id) return json({ ok: true, has_update: false, item: null });
      if (url.searchParams.get("device_id") === latest.device_id) return json({ ok: true, has_update: false, item: null });
      return json({ ok: true, has_update: true, item: latest });
    }

    if (req.method === "POST" && path === "/api/files/upload") {
      const form = await req.formData();
      const uploaded = form.get("file");
      if (!(uploaded instanceof File)) return json({ detail: "file is required" }, 422);
      const fileId = crypto.randomUUID();
      const filename = safeFilename(uploaded.name || "upload.bin");
      const storagePath = `${fileId}/${filename}`;
      const bytes = new Uint8Array(await uploaded.arrayBuffer());
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, { contentType: uploaded.type || "application/octet-stream", upsert: false });
      if (uploadError) return json({ detail: uploadError.message }, 500);
      const row = { id: fileId, filename, storage_path: storagePath, size: bytes.length, mime_type: uploaded.type || "application/octet-stream", source: String(form.get("source") ?? "unknown"), device_id: String(form.get("device_id") ?? ""), status: "pending", expires_at: addSeconds(FILE_TTL_SECONDS) };
      const { data, error } = await supabase.from("cloudbridge_files").insert(row).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, item: publicFileRecord(data) });
    }

    if (req.method === "GET" && path === "/api/files/pending") {
      const deviceId = url.searchParams.get("device_id");
      let query = supabase.from("cloudbridge_files").select("*").eq("status", "pending").gt("expires_at", nowIso()).order("uploaded_at", { ascending: true });
      if (deviceId) query = query.neq("device_id", deviceId);
      const { data, error } = await query;
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, items: (data ?? []).map(publicFileRecord) });
    }

    const downloadMatch = path.match(/^\/api\/files\/([^/]+)\/download$/);
    if (req.method === "GET" && downloadMatch) {
      const fileId = downloadMatch[1];
      const { data: record, error } = await supabase.from("cloudbridge_files").select("*").eq("id", fileId).single();
      if (error || !record) return json({ detail: "File not found" }, 404);
      if (new Date(record.expires_at).getTime() <= Date.now()) return json({ detail: "File expired" }, 410);
      const { data, error: downloadError } = await supabase.storage.from(BUCKET).download(record.storage_path);
      if (downloadError || !data) return json({ detail: downloadError?.message ?? "File payload not found" }, 410);
      return new Response(data, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": record.mime_type, "Content-Disposition": `attachment; filename="${String(record.filename).replaceAll('"', "")}"` },
      });
    }

    const ackMatch = path.match(/^\/api\/files\/([^/]+)\/ack$/);
    if (req.method === "POST" && ackMatch) {
      const fileId = ackMatch[1];
      const { data: record, error: getError } = await supabase.from("cloudbridge_files").select("*").eq("id", fileId).single();
      if (getError || !record) return json({ detail: "File not found" }, 404);
      const { data, error } = await supabase.from("cloudbridge_files").update({ status: "downloaded", downloaded_at: nowIso() }).eq("id", fileId).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      if (DELETE_AFTER_ACK) await supabase.storage.from(BUCKET).remove([record.storage_path]);
      return json({ ok: true, item: publicFileRecord(data) });
    }

    return json({ detail: "Not found" }, 404);
  } catch (error) {
    return json({ detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
