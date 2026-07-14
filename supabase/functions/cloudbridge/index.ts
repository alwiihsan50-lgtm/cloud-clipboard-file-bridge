import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const PROJECT_REF = "ajlkfzgpheegmwsnspxw";
const APP_NAME = "CloudBridge";
const BUCKET = Deno.env.get("SUPABASE_STORAGE_BUCKET") ?? "cloudbridge-files";
const FILE_TTL_SECONDS = Number(Deno.env.get("CLOUD_BRIDGE_FILE_TTL_SECONDS") ?? "86400");
const PAIRING_TTL_SECONDS = Number(Deno.env.get("CLOUD_BRIDGE_PAIRING_TTL_SECONDS") ?? "600");
const CLIPBOARD_RETENTION_SECONDS = Number(Deno.env.get("CLOUD_BRIDGE_CLIPBOARD_RETENTION_SECONDS") ?? "604800");
const FILE_CLEANUP_GRACE_SECONDS = Number(Deno.env.get("CLOUD_BRIDGE_FILE_CLEANUP_GRACE_SECONDS") ?? "86400");
const CLEANUP_INTERVAL_SECONDS = Number(Deno.env.get("CLOUD_BRIDGE_CLEANUP_INTERVAL_SECONDS") ?? "86400");
const PUBLIC_BASE_URL =
  Deno.env.get("CLOUD_BRIDGE_PUBLIC_URL") ??
  `https://${PROJECT_REF}.supabase.co/functions/v1/cloudbridge`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

type AuthContext = { kind: "admin" | "device"; token: string; device_id?: string };
type JsonRecord = Record<string, unknown>;

function getSecretKey(): string {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys);
      if (parsed.default) return parsed.default;
    } catch {
      // Fall through to legacy service role key.
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

function beforeSeconds(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
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

function normalizePath(url: URL): string {
  const path = url.pathname || "/";
  const prefixes = ["/functions/v1/cloudbridge", "/cloudbridge"];
  for (const prefix of prefixes) {
    if (path === prefix) return "/";
    if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length) || "/";
  }
  return path;
}

function safeFilename(name: string): string {
  const cleaned = name.split(/[\\/]/).pop()?.replaceAll("\0", "").trim() || "upload.bin";
  return cleaned.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") || "upload.bin";
}

function publicFileRecord(record: JsonRecord): JsonRecord {
  const copy = { ...record };
  delete copy.storage_path;
  return copy;
}

function clampLimit(value: string | null): number {
  const parsed = Number(value ?? "50");
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function pinOwner(auth: AuthContext): string {
  return auth.device_id ?? "admin";
}

async function updateMaintenanceTimestamp(): Promise<void> {
  await supabase
    .from("cloudbridge_maintenance")
    .upsert({ key: "cleanup", last_cleanup_at: nowIso(), updated_at: nowIso() }, { onConflict: "key" });
}

async function runCleanup(force = false): Promise<JsonRecord> {
  if (!force) {
    const { data: maintenance } = await supabase
      .from("cloudbridge_maintenance")
      .select("last_cleanup_at")
      .eq("key", "cleanup")
      .maybeSingle();
    const lastCleanup = maintenance?.last_cleanup_at ? new Date(maintenance.last_cleanup_at).getTime() : 0;
    if (lastCleanup && Date.now() - lastCleanup < CLEANUP_INTERVAL_SECONDS * 1000) {
      return { ran: false, reason: "recent", clipboard_deleted: 0, files_deleted: 0 };
    }
  }

  const clipboardCutoff = beforeSeconds(CLIPBOARD_RETENTION_SECONDS);
  const fileCutoff = beforeSeconds(FILE_CLEANUP_GRACE_SECONDS);
  const now = nowIso();

  const { data: clipboardRows, error: clipboardSelectError } = await supabase
    .from("cloudbridge_clipboard")
    .select("id")
    .eq("pinned", false)
    .lt("created_at", clipboardCutoff)
    .limit(500);
  if (clipboardSelectError) throw clipboardSelectError;

  const clipboardIds = (clipboardRows ?? []).map((row) => row.id);
  if (clipboardIds.length) {
    const { error } = await supabase.from("cloudbridge_clipboard").delete().in("id", clipboardIds);
    if (error) throw error;
  }

  const { data: fileRows, error: fileSelectError } = await supabase
    .from("cloudbridge_files")
    .select("id,storage_path,status,downloaded_at,expires_at")
    .eq("pinned", false)
    .limit(500);
  if (fileSelectError) throw fileSelectError;

  const filesToDelete = (fileRows ?? []).filter((row) => {
    const downloadedAt = row.downloaded_at ? new Date(row.downloaded_at).getTime() : 0;
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
    const downloadedExpired = row.status === "downloaded" && downloadedAt > 0 && downloadedAt < new Date(fileCutoff).getTime();
    const ttlExpired = expiresAt > 0 && expiresAt < new Date(fileCutoff).getTime();
    return downloadedExpired || ttlExpired;
  });

  const storagePaths = filesToDelete.map((row) => row.storage_path).filter(Boolean);
  if (storagePaths.length) await supabase.storage.from(BUCKET).remove(storagePaths);

  const fileIds = filesToDelete.map((row) => row.id);
  if (fileIds.length) {
    const { error } = await supabase.from("cloudbridge_files").delete().in("id", fileIds);
    if (error) throw error;
  }

  await updateMaintenanceTimestamp();
  return {
    ran: true,
    clipboard_deleted: clipboardIds.length,
    files_deleted: fileIds.length,
    clipboard_cutoff: clipboardCutoff,
    file_cutoff: fileCutoff,
    completed_at: now,
  };
}

async function maybeCleanup(): Promise<void> {
  try {
    await runCleanup(false);
  } catch (error) {
    console.error("CloudBridge cleanup failed", error);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    const path = normalizePath(url);

    if (req.method === "GET" && path === "/health") return json({ ok: true, service: APP_NAME, mode: "supabase-edge" });
    if (req.method === "GET" && (path === "/" || path === "/app")) {
      return text("CloudBridge API is online. Use the GitHub Pages PWA for the app.");
    }

    if (req.method === "POST" && path === "/api/pairing/claim") {
      const body = await req.json();
      const codeHash = await sha256(String(body.code ?? ""));
      const { data: sessions, error: sessionError } = await supabase
        .from("cloudbridge_pairing_sessions")
        .select("*")
        .eq("code_hash", codeHash)
        .is("claimed_at", null)
        .gt("expires_at", nowIso())
        .limit(1);
      if (sessionError) return json({ detail: sessionError.message }, 500);
      if (!sessions?.length) return json({ detail: "Pairing code is invalid or expired" }, 404);

      const deviceId = String(body.device_id ?? "");
      if (!deviceId) return json({ detail: "device_id is required" }, 422);
      const token = randomToken(32);
      const tokenHash = await sha256(token);
      const { error: deviceError } = await supabase.from("cloudbridge_devices").upsert(
        { device_id: deviceId, label: String(body.label ?? "iPhone"), platform: "ios", token_hash: tokenHash, revoked: false },
        { onConflict: "device_id" },
      );
      if (deviceError) return json({ detail: deviceError.message }, 500);
      const { error: updateError } = await supabase
        .from("cloudbridge_pairing_sessions")
        .update({ claimed_by_device_id: deviceId, claimed_at: nowIso() })
        .eq("id", sessions[0].id);
      if (updateError) return json({ detail: updateError.message }, 500);
      return json({ ok: true, device_id: deviceId, token });
    }

    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;

    if (req.method === "GET" && path === "/api/me") return json({ ok: true, auth: auth.kind, device_id: auth.device_id ?? null });

    if (req.method === "POST" && path === "/api/cleanup") {
      if (auth.kind !== "admin") return json({ detail: "Admin token required" }, 401);
      return json({ ok: true, cleanup: await runCleanup(true) });
    }

    if (req.method === "POST" && path === "/api/pairing/create") {
      if (auth.kind !== "admin") return json({ detail: "Admin token required" }, 401);
      const body = await req.json();
      const code = randomToken(18);
      const row = {
        code_hash: await sha256(code),
        created_by_device_id: String(body.device_id ?? "windows"),
        created_by_label: String(body.label ?? "Windows PC"),
        expires_at: addSeconds(PAIRING_TTL_SECONDS),
      };
      const { data, error } = await supabase.from("cloudbridge_pairing_sessions").insert(row).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      await maybeCleanup();
      return json({ ok: true, code, pairing_url: `${PUBLIC_BASE_URL}/app?code=${encodeURIComponent(code)}`, expires_at: data.expires_at });
    }

    if (req.method === "POST" && path === "/api/clipboard/push") {
      const body = await req.json();
      if (!body.content || !body.device_id) return json({ detail: "content and device_id are required" }, 422);
      const { data, error } = await supabase
        .from("cloudbridge_clipboard")
        .insert({ content: String(body.content), source: String(body.source ?? "unknown"), device_id: String(body.device_id) })
        .select("*")
        .single();
      if (error) return json({ detail: error.message }, 500);
      await maybeCleanup();
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

    if (req.method === "GET" && path === "/api/clipboard/history") {
      const { data, error } = await supabase
        .from("cloudbridge_clipboard")
        .select("id,content,source,device_id,version,created_at,pinned,pinned_at,pinned_by_device_id")
        .order("pinned", { ascending: false })
        .order("version", { ascending: false })
        .limit(clampLimit(url.searchParams.get("limit")));
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, items: data ?? [] });
    }

    const clipboardPinMatch = path.match(/^\/api\/clipboard\/([^/]+)\/(pin|unpin)$/);
    if (req.method === "POST" && clipboardPinMatch) {
      const isPin = clipboardPinMatch[2] === "pin";
      const update = isPin
        ? { pinned: true, pinned_at: nowIso(), pinned_by_device_id: pinOwner(auth) }
        : { pinned: false, pinned_at: null, pinned_by_device_id: null };
      const { data, error } = await supabase
        .from("cloudbridge_clipboard")
        .update(update)
        .eq("id", clipboardPinMatch[1])
        .select("id,content,source,device_id,version,created_at,pinned,pinned_at,pinned_by_device_id")
        .single();
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, item: data });
    }

    if (req.method === "POST" && path === "/api/files/upload") {
      const form = await req.formData();
      const uploaded = form.get("file");
      if (!(uploaded instanceof File)) return json({ detail: "file is required" }, 422);
      const fileId = crypto.randomUUID();
      const filename = safeFilename(uploaded.name || "upload.bin");
      const storagePath = `${fileId}/${filename}`;
      const bytes = new Uint8Array(await uploaded.arrayBuffer());
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
        contentType: uploaded.type || "application/octet-stream",
        upsert: false,
      });
      if (uploadError) return json({ detail: uploadError.message }, 500);
      const row = {
        id: fileId,
        filename,
        storage_path: storagePath,
        size: bytes.length,
        mime_type: uploaded.type || "application/octet-stream",
        source: String(form.get("source") ?? "unknown"),
        device_id: String(form.get("device_id") ?? ""),
        status: "pending",
        expires_at: addSeconds(FILE_TTL_SECONDS),
      };
      const { data, error } = await supabase.from("cloudbridge_files").insert(row).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      await maybeCleanup();
      return json({ ok: true, item: publicFileRecord(data) });
    }

    if (req.method === "GET" && path === "/api/files/pending") {
      const deviceId = url.searchParams.get("device_id");
      let query = supabase
        .from("cloudbridge_files")
        .select("*")
        .eq("status", "pending")
        .gt("expires_at", nowIso())
        .order("uploaded_at", { ascending: true });
      if (deviceId) query = query.neq("device_id", deviceId);
      const { data, error } = await query;
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, items: (data ?? []).map(publicFileRecord) });
    }

    if (req.method === "GET" && path === "/api/files/history") {
      const { data, error } = await supabase
        .from("cloudbridge_files")
        .select("*")
        .order("pinned", { ascending: false })
        .order("uploaded_at", { ascending: false })
        .limit(clampLimit(url.searchParams.get("limit")));
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, items: (data ?? []).map(publicFileRecord) });
    }

    const fileDownloadMatch = path.match(/^\/api\/files\/([^/]+)\/download$/);
    if (req.method === "GET" && fileDownloadMatch) {
      const { data: record, error } = await supabase.from("cloudbridge_files").select("*").eq("id", fileDownloadMatch[1]).single();
      if (error || !record) return json({ detail: "File not found" }, 404);
      if (!record.pinned && new Date(record.expires_at).getTime() <= Date.now()) return json({ detail: "File expired" }, 410);
      const { data, error: downloadError } = await supabase.storage.from(BUCKET).download(record.storage_path);
      if (downloadError || !data) return json({ detail: downloadError?.message ?? "File payload not found" }, 410);
      return new Response(data, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": record.mime_type,
          "Content-Disposition": `attachment; filename="${String(record.filename).replaceAll('"', "")}"`,
        },
      });
    }

    const fileAckMatch = path.match(/^\/api\/files\/([^/]+)\/ack$/);
    if (req.method === "POST" && fileAckMatch) {
      const { data, error } = await supabase
        .from("cloudbridge_files")
        .update({ status: "downloaded", downloaded_at: nowIso() })
        .eq("id", fileAckMatch[1])
        .select("*")
        .single();
      if (error) return json({ detail: error.message }, 500);
      await maybeCleanup();
      return json({ ok: true, item: publicFileRecord(data) });
    }

    const filePinMatch = path.match(/^\/api\/files\/([^/]+)\/(pin|unpin)$/);
    if (req.method === "POST" && filePinMatch) {
      const isPin = filePinMatch[2] === "pin";
      const update = isPin
        ? { pinned: true, pinned_at: nowIso(), pinned_by_device_id: pinOwner(auth) }
        : { pinned: false, pinned_at: null, pinned_by_device_id: null };
      const { data, error } = await supabase.from("cloudbridge_files").update(update).eq("id", filePinMatch[1]).select("*").single();
      if (error) return json({ detail: error.message }, 500);
      return json({ ok: true, item: publicFileRecord(data) });
    }

    return json({ detail: "Not found" }, 404);
  } catch (error) {
    return json({ detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
