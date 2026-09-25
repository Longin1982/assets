// Necesar Marfa — Telegram bot (Supabase Edge Function)
// Multi-supplier needed-items for group "Necesar marfa".

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Config = {
  TG_BOT_TOKEN: string;
  TG_WEBHOOK_SECRET: string;
  CRON_SECRET: string;
  ADMIN_USERNAME: string;
};

type Supplier = { id: number; name: string; keywords: string[] };

type TgUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TgChat = { id: number; type: string };

type TgPhotoSize = { file_id: string; width?: number; height?: number };

type TgMessage = {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: { file_id: string; mime_type?: string };
  date?: number;
  reply_to_message?: { message_id: number; from?: TgUser };
};

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
};

type OrderRow = {
  id: number;
  chat_id: number;
  message_id: number;
  tag_message_id: number | null;
  supplier_id: number | null;
  author_id: number;
  author: string;
  text: string;
  photo_file_id: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
};

const OK_RE = /^(ok|okay|oke|okk|k|👍)$/i;
const STITCH_MS = 5 * 60 * 1000;

let cachedConfig: Config | null = null;
let cachedSuppliers: Supplier[] | null = null;

async function loadConfig(client: SupabaseClient): Promise<Config> {
  if (cachedConfig) return cachedConfig;
  const { data, error } = await client.from("necesar_config").select("key, value");
  if (error) throw error;
  const map = Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  cachedConfig = {
    TG_BOT_TOKEN: Deno.env.get("TG_BOT_TOKEN") ?? map.TG_BOT_TOKEN ?? "",
    TG_WEBHOOK_SECRET: Deno.env.get("TG_WEBHOOK_SECRET") ?? map.TG_WEBHOOK_SECRET ?? "",
    CRON_SECRET: Deno.env.get("CRON_SECRET") ?? map.CRON_SECRET ?? "",
    ADMIN_USERNAME: (Deno.env.get("ADMIN_USERNAME") ?? map.ADMIN_USERNAME ?? "Longin_x").replace(/^@/, ""),
  };
  return cachedConfig;
}

async function loadSuppliers(): Promise<Supplier[]> {
  if (cachedSuppliers) return cachedSuppliers;
  const { data, error } = await db.from("suppliers").select("id, name, keywords").order("id");
  if (error) throw error;
  cachedSuppliers = (data ?? []) as Supplier[];
  return cachedSuppliers;
}

function invalidateSuppliers() {
  cachedSuppliers = null;
}

function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function displayName(user: TgUser | undefined): string {
  if (!user) return "Membru";
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (user.username) return user.username;
  return "Membru";
}

function isAdmin(user: TgUser | undefined, adminUsername: string): boolean {
  if (!user?.username) return false;
  return user.username.toLowerCase() === adminUsername.toLowerCase();
}

function isOkText(text: string): boolean {
  return OK_RE.test(text.trim());
}

function messageLink(chatId: number, messageId: number): string {
  const id = String(chatId);
  const stripped = id.startsWith("-100") ? id.slice(4) : id.replace(/^-/, "");
  return `https://t.me/c/${stripped}/${messageId}`;
}

function bucharestHour(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Bucharest",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0");
}

function formatBucharest(iso: string): string {
  return new Intl.DateTimeFormat("ro-RO", {
    timeZone: "Europe/Bucharest",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function preview(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, max - 1) + "…";
}

function findSupplierInText(text: string, suppliers: Supplier[]): Supplier | null {
  const n = normalize(text);
  // Longer keywords first so "ocean fish" beats shorter noise
  const ranked = [...suppliers].sort((a, b) => {
    const maxA = Math.max(0, ...(a.keywords ?? []).map((k) => k.length));
    const maxB = Math.max(0, ...(b.keywords ?? []).map((k) => k.length));
    return maxB - maxA;
  });
  for (const s of ranked) {
    for (const kw of s.keywords ?? []) {
      const nk = normalize(kw);
      if (nk && n.includes(nk)) return s;
    }
  }
  return null;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/)[0] ?? "").trim();
}

function extractPhotoFileId(msg: TgMessage): string | null {
  if (msg.photo?.length) return msg.photo[msg.photo.length - 1].file_id;
  if (msg.document?.mime_type?.startsWith("image/")) return msg.document.file_id;
  return null;
}

function messageBody(msg: TgMessage): string {
  if (typeof msg.text === "string") return msg.text;
  if (typeof msg.caption === "string") return msg.caption;
  if (extractPhotoFileId(msg)) return "[foto]";
  return "";
}

function isQuestion(text: string, hasPhoto: boolean): boolean {
  if (hasPhoto) return false;
  const t = text.trim();
  return t.length > 0 && t.length < 40 && t.endsWith("?");
}

async function tg(token: string, method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error("tg", method, JSON.stringify(j).slice(0, 500));
  return j;
}

async function claimUpdate(updateId: number): Promise<boolean> {
  const { error } = await db.from("supplier_updates").insert({ update_id: updateId });
  if (error) {
    if (String(error.code) === "23505" || /duplicate|unique/i.test(error.message ?? "")) return false;
    throw error;
  }
  return true;
}

async function getActiveSupplierId(chatId: number): Promise<number | null> {
  const { data, error } = await db.from("group_state").select("active_supplier_id").eq("chat_id", chatId).maybeSingle();
  if (error) throw error;
  return data?.active_supplier_id ?? null;
}

async function setActiveSupplier(chatId: number, supplierId: number | null) {
  const { error } = await db.from("group_state").upsert({
    chat_id: chatId,
    active_supplier_id: supplierId,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function supplierName(id: number | null, suppliers: Supplier[]): Promise<string> {
  if (id == null) return "Nespecificat";
  return suppliers.find((s) => s.id === id)?.name ?? "Nespecificat";
}

async function rebuildOrderText(orderId: number): Promise<string> {
  const { data, error } = await db
    .from("supplier_order_messages")
    .select("message_id, text")
    .eq("order_id", orderId)
    .order("message_id", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { message_id: number; text: string }[]).map((r) => r.text).join("\n");
}

async function confirmByMessageIds(chatId: number, messageId: number): Promise<number> {
  // Find order via order_messages or tag_message_id
  const { data: link } = await db
    .from("supplier_order_messages")
    .select("order_id")
    .eq("chat_id", chatId)
    .eq("message_id", messageId)
    .maybeSingle();

  let orderId = link?.order_id as number | undefined;

  if (orderId == null) {
    const { data: byTag } = await db
      .from("supplier_orders")
      .select("id")
      .eq("chat_id", chatId)
      .eq("tag_message_id", messageId)
      .is("confirmed_at", null)
      .maybeSingle();
    orderId = byTag?.id as number | undefined;
  }

  if (orderId == null) return 0;

  const { data, error } = await db
    .from("supplier_orders")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("id", orderId)
    .is("confirmed_at", null)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

async function confirmAllOpen(chatId: number): Promise<number> {
  const { data, error } = await db
    .from("supplier_orders")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("chat_id", chatId)
    .is("confirmed_at", null)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

async function handleAdminOk(cfg: Config, msg: TgMessage): Promise<Response> {
  const chatId = msg.chat.id;
  let confirmed = 0;
  if (msg.reply_to_message) {
    confirmed = await confirmByMessageIds(chatId, msg.reply_to_message.message_id);
  } else {
    confirmed = await confirmAllOpen(chatId);
  }
  if (confirmed > 0) {
    await tg(cfg.TG_BOT_TOKEN, "setMessageReaction", {
      chat_id: chatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  }
  return new Response(confirmed > 0 ? `confirmed:${confirmed}` : "ok-noop");
}

async function handleFurnizorCommand(cfg: Config, msg: TgMessage, text: string): Promise<Response> {
  // /furnizor Nume, keyword1, keyword2
  const raw = text.replace(/^\/furnizor(?:@\w+)?\s*/i, "").trim();
  if (!raw) {
    await tg(cfg.TG_BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id,
      reply_to_message_id: msg.message_id,
      text: "Folosire: /furnizor Nume, keyword1, keyword2",
    });
    return new Response("furnizor-usage");
  }
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const name = parts[0];
  const keywords = parts.slice(1).map((k) => normalize(k)).filter(Boolean);
  if (!name) {
    await tg(cfg.TG_BOT_TOKEN, "sendMessage", {
      chat_id: msg.chat.id,
      reply_to_message_id: msg.message_id,
      text: "Folosire: /furnizor Nume, keyword1, keyword2",
    });
    return new Response("furnizor-usage");
  }
  if (!keywords.length) keywords.push(normalize(name));

  const { error } = await db.from("suppliers").upsert(
    { name, keywords },
    { onConflict: "name" },
  );
  if (error) throw error;
  invalidateSuppliers();

  await tg(cfg.TG_BOT_TOKEN, "sendMessage", {
    chat_id: msg.chat.id,
    reply_to_message_id: msg.message_id,
    text: "✅ Furnizor salvat",
  });
  return new Response("furnizor-saved");
}

async function handleLongin(cfg: Config, msg: TgMessage, suppliers: Supplier[]): Promise<Response> {
  const text = (msg.text ?? msg.caption ?? "").trim();

  if (text.toLowerCase().startsWith("/furnizor")) {
    return await handleFurnizorCommand(cfg, msg, text);
  }

  if (text && isOkText(text)) {
    return await handleAdminOk(cfg, msg);
  }

  if (text) {
    const found = findSupplierInText(text, suppliers);
    if (found) {
      await setActiveSupplier(msg.chat.id, found.id);
      return new Response(`active-supplier:${found.name}`);
    }
  }

  return new Response("admin-skip");
}

async function findStitchTarget(
  chatId: number,
  authorId: number,
  supplierId: number | null,
): Promise<OrderRow | null> {
  const since = new Date(Date.now() - STITCH_MS).toISOString();
  let q = db
    .from("supplier_orders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("author_id", authorId)
    .is("confirmed_at", null)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(1);

  q = supplierId == null ? q.is("supplier_id", null) : q.eq("supplier_id", supplierId);

  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return (data as OrderRow | null) ?? null;
}

async function resolveSupplierId(
  chatId: number,
  body: string,
  suppliers: Supplier[],
): Promise<number | null> {
  const fromFirst = findSupplierInText(firstLine(body), suppliers);
  if (fromFirst) return fromFirst.id;
  return await getActiveSupplierId(chatId);
}

async function handleMemberNewOrStitch(
  cfg: Config,
  msg: TgMessage,
  suppliers: Supplier[],
): Promise<Response> {
  const chatId = msg.chat.id;
  const authorId = msg.from!.id;
  const author = displayName(msg.from);
  const photoFileId = extractPhotoFileId(msg);
  const body = messageBody(msg);

  if (body.trim().startsWith("/")) return new Response("command");
  if (isQuestion(body, Boolean(photoFileId))) return new Response("question");
  if (!body.trim() && !photoFileId) return new Response("empty");

  const supplierId = await resolveSupplierId(chatId, body, suppliers);
  const furnizorLabel = await supplierName(supplierId, suppliers);

  const stitch = await findStitchTarget(chatId, authorId, supplierId);
  const now = new Date().toISOString();

  if (stitch) {
    const newText = stitch.text ? `${stitch.text}\n${body}` : body;
    const { error: updErr } = await db.from("supplier_orders").update({
      text: newText,
      updated_at: now,
      photo_file_id: photoFileId ?? stitch.photo_file_id,
    }).eq("id", stitch.id);
    if (updErr) throw updErr;

    const { error: msgErr } = await db.from("supplier_order_messages").upsert({
      order_id: stitch.id,
      chat_id: chatId,
      message_id: msg.message_id,
      text: body,
    }, { onConflict: "chat_id,message_id" });
    if (msgErr) throw msgErr;

    return new Response(`stitched:${stitch.id}`);
  }

  // New order
  const { data: order, error: insErr } = await db.from("supplier_orders").insert({
    chat_id: chatId,
    message_id: msg.message_id,
    supplier_id: supplierId,
    author_id: authorId,
    author,
    text: body || "[foto]",
    photo_file_id: photoFileId,
    created_at: now,
    updated_at: now,
  }).select("*").single();
  if (insErr) throw insErr;

  const { error: linkErr } = await db.from("supplier_order_messages").insert({
    order_id: order.id,
    chat_id: chatId,
    message_id: msg.message_id,
    text: body || "[foto]",
  });
  if (linkErr) throw linkErr;

  const finalTag = photoFileId
    ? `@${cfg.ADMIN_USERNAME} 📷 necesar foto de la ${author} → ${furnizorLabel}`
    : `@${cfg.ADMIN_USERNAME} 📦 necesar nou de la ${author} → ${furnizorLabel}`;

  const sent = await tg(cfg.TG_BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    reply_to_message_id: msg.message_id,
    text: finalTag,
  });

  if (sent?.ok) {
    await db.from("supplier_orders").update({
      tag_message_id: Number(sent.result.message_id),
    }).eq("id", order.id);
  }

  return new Response(`new:${order.id}`);
}

async function handleEditedMessage(msg: TgMessage, suppliers: Supplier[]): Promise<Response> {
  if (!msg.from || msg.from.is_bot) return new Response("skip");
  const chatId = msg.chat.id;
  const body = messageBody(msg);

  const { data: link, error } = await db
    .from("supplier_order_messages")
    .select("order_id")
    .eq("chat_id", chatId)
    .eq("message_id", msg.message_id)
    .maybeSingle();
  if (error) throw error;
  if (!link) return new Response("edit-orphan");

  const orderId = link.order_id as number;

  const { error: updMsgErr } = await db.from("supplier_order_messages").update({
    text: body || "[foto]",
  }).eq("chat_id", chatId).eq("message_id", msg.message_id);
  if (updMsgErr) throw updMsgErr;

  const rebuilt = await rebuildOrderText(orderId);
  const patch: Record<string, unknown> = {
    text: rebuilt,
    updated_at: new Date().toISOString(),
  };

  const fromFirst = findSupplierInText(firstLine(body), suppliers);
  if (fromFirst) patch.supplier_id = fromFirst.id;

  const { error: updOrdErr } = await db.from("supplier_orders").update(patch).eq("id", orderId).is("confirmed_at", null);
  if (updOrdErr) throw updOrdErr;

  return new Response(`edited:${orderId}`);
}

async function sendReminders(cfg: Config, force: boolean): Promise<Response> {
  if (!force && bucharestHour() !== 15) {
    return new Response(JSON.stringify({ skipped: true, reason: "not-15-bucharest" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const suppliers = await loadSuppliers();
  const { data, error } = await db
    .from("supplier_orders")
    .select("*")
    .is("confirmed_at", null)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const open = (data ?? []) as OrderRow[];
  if (!open.length) {
    return new Response(JSON.stringify({ sent: 0, reason: "no-open" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const byChat = new Map<number, OrderRow[]>();
  for (const row of open) {
    const list = byChat.get(row.chat_id) ?? [];
    list.push(row);
    byChat.set(row.chat_id, list);
  }

  const preferred = ["Aqvila", "Imdia", "Ocean Fish", "Olimpic"];

  function supplierSortKey(id: number | null): string {
    if (id == null) return "zzz_nespecificat";
    const name = suppliers.find((s) => s.id === id)?.name ?? "Nespecificat";
    if (name === "Nespecificat") return "zzz_nespecificat";
    const idx = preferred.indexOf(name);
    if (idx >= 0) return `${idx}_${name}`;
    return `50_${name}`;
  }

  let sent = 0;
  for (const [chatId, orders] of byChat) {
    const groups = new Map<string, OrderRow[]>();
    for (const o of orders) {
      const label = await supplierName(o.supplier_id, suppliers);
      const list = groups.get(label) ?? [];
      list.push(o);
      groups.set(label, list);
    }

    const labels = [...groups.keys()].sort((a, b) => {
      const idA = a === "Nespecificat" ? null : suppliers.find((s) => s.name === a)?.id ?? null;
      const idB = b === "Nespecificat" ? null : suppliers.find((s) => s.name === b)?.id ?? null;
      return supplierSortKey(idA).localeCompare(supplierSortKey(idB));
    });

    const blocks: string[] = [];
    for (const label of labels) {
      const rows = groups.get(label)!;
      const lines = rows.map((o) => {
        const when = escapeHtml(formatBucharest(o.created_at));
        const who = escapeHtml(o.author);
        const text = escapeHtml(preview(o.text));
        const link = messageLink(o.chat_id, o.message_id);
        return `• <a href="${link}">${who} · ${when}</a> — ${text}`;
      });
      blocks.push(`<b>${escapeHtml(label)}</b>\n${lines.join("\n")}`);
    }

    const html =
      `@${escapeHtml(cfg.ADMIN_USERNAME)} ⏰ ${orders.length} necesar(e) fără „ok”:\n\n` +
      `${blocks.join("\n\n")}\n\n` +
      `Le-ai transmis la furnizori? Reply „ok” pe necesar sau „ok” simplu pentru toate.`;

    const res = await tg(cfg.TG_BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    if (res?.ok) sent++;
  }

  return new Response(JSON.stringify({ sent, chats: byChat.size, orders: open.length, force }), {
    headers: { "content-type": "application/json" },
  });
}

async function handleMessage(cfg: Config, msg: TgMessage, suppliers: Supplier[]): Promise<Response> {
  if (!msg.from) return new Response("skip");
  if (msg.from.is_bot) return new Response("bot");
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return new Response("not-group");

  if (isAdmin(msg.from, cfg.ADMIN_USERNAME)) {
    return await handleLongin(cfg, msg, suppliers);
  }
  return await handleMemberNewOrStitch(cfg, msg, suppliers);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  try {
    const cfg = await loadConfig(db);

    if (url.searchParams.get("cron") === "1") {
      if (req.headers.get("x-cron-secret") !== cfg.CRON_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      if (!cfg.TG_BOT_TOKEN) {
        return new Response(JSON.stringify({ error: "missing TG_BOT_TOKEN" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      const force = url.searchParams.get("force") === "1";
      return await sendReminders(cfg, force);
    }

    if (req.method !== "POST") {
      return new Response("Necesar Marfa bot ok");
    }

    if (!cfg.TG_BOT_TOKEN || !cfg.TG_WEBHOOK_SECRET) {
      return new Response("misconfigured", { status: 500 });
    }

    if (req.headers.get("x-telegram-bot-api-secret-token") !== cfg.TG_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const update = (await req.json()) as TgUpdate;
    if (update.update_id == null) return new Response("no-update-id", { status: 400 });

    const fresh = await claimUpdate(update.update_id);
    if (!fresh) return new Response("dup");

    const suppliers = await loadSuppliers();

    if (update.edited_message) {
      const msg = update.edited_message;
      if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return new Response("not-group");
      if (isAdmin(msg.from, cfg.ADMIN_USERNAME)) return new Response("admin-edit-skip");
      return await handleEditedMessage(msg, suppliers);
    }

    if (update.message) {
      return await handleMessage(cfg, update.message, suppliers);
    }

    return new Response("skip");
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
