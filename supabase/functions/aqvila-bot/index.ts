// Necesar Aqvila — Telegram bot (Supabase Edge Function)
// Members post supply needs; Longin_x confirms; daily 15:00 Europe/Bucharest reminder.

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

type TgUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TgChat = {
  id: number;
  type: string;
};

type TgMessage = {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  date?: number;
  reply_to_message?: {
    message_id: number;
    from?: TgUser;
    text?: string;
  };
};

type TgUpdate = {
  update_id: number;
  message?: TgMessage;
};

type OrderRow = {
  id: number;
  chat_id: number;
  message_id: number;
  tag_message_id: number | null;
  author: string;
  text: string;
  created_at: string;
};

const OK_RE = /^(ok|okay|oke|k|👍)$/i;

let cachedConfig: Config | null = null;
let cachedBotUsername: string | null = null;

async function loadConfig(client: SupabaseClient): Promise<Config> {
  if (cachedConfig) return cachedConfig;

  const { data, error } = await client.from("aqvila_config").select("key, value");
  if (error) throw error;

  const map = Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));

  const cfg: Config = {
    TG_BOT_TOKEN: Deno.env.get("TG_BOT_TOKEN") ?? map.TG_BOT_TOKEN ?? "",
    TG_WEBHOOK_SECRET: Deno.env.get("TG_WEBHOOK_SECRET") ?? map.TG_WEBHOOK_SECRET ?? "",
    CRON_SECRET: Deno.env.get("CRON_SECRET") ?? map.CRON_SECRET ?? "",
    ADMIN_USERNAME: (Deno.env.get("ADMIN_USERNAME") ?? map.ADMIN_USERNAME ?? "Longin_x").replace(/^@/, ""),
  };

  cachedConfig = cfg;
  return cfg;
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
    year: "numeric",
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

async function botUsername(token: string): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  const info = await tg(token, "getMe", {});
  cachedBotUsername = info?.result?.username ?? "NecesarAqvilaBot";
  return cachedBotUsername!;
}

async function claimUpdate(updateId: number): Promise<boolean> {
  const { error } = await db.from("aqvila_updates").insert({ update_id: updateId });
  if (error) {
    // unique violation → duplicate
    if (String(error.code) === "23505" || /duplicate|unique/i.test(error.message ?? "")) {
      return false;
    }
    throw error;
  }
  return true;
}

async function handleNewNecesar(
  cfg: Config,
  msg: TgMessage,
  author: string,
): Promise<Response> {
  const chatId = msg.chat.id;
  const adminTag = `@${cfg.ADMIN_USERNAME}`;
  const replyText = `${adminTag} 📦 necesar nou de la ${author}`;

  const sent = await tg(cfg.TG_BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    reply_to_message_id: msg.message_id,
    text: replyText,
  });

  const tagMessageId: number | null = sent?.ok ? Number(sent.result.message_id) : null;

  const { error } = await db.from("aqvila_orders").upsert(
    {
      chat_id: chatId,
      message_id: msg.message_id,
      tag_message_id: tagMessageId,
      author,
      text: msg.text!,
    },
    { onConflict: "chat_id,message_id" },
  );
  if (error) throw error;

  return new Response("necesar");
}

async function confirmOrders(
  chatId: number,
  orders: OrderRow[],
): Promise<number> {
  if (!orders.length) return 0;
  const ids = orders.map((o) => o.id);
  const { error } = await db
    .from("aqvila_orders")
    .update({ confirmed_at: new Date().toISOString() })
    .in("id", ids)
    .is("confirmed_at", null);
  if (error) throw error;
  return ids.length;
}

async function findOrderByReply(
  chatId: number,
  replyMessageId: number,
): Promise<OrderRow | null> {
  const { data: byOrig } = await db
    .from("aqvila_orders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("message_id", replyMessageId)
    .is("confirmed_at", null)
    .maybeSingle();
  if (byOrig) return byOrig as OrderRow;

  const { data: byTag } = await db
    .from("aqvila_orders")
    .select("*")
    .eq("chat_id", chatId)
    .eq("tag_message_id", replyMessageId)
    .is("confirmed_at", null)
    .maybeSingle();
  return (byTag as OrderRow | null) ?? null;
}

async function handleAdminOk(cfg: Config, msg: TgMessage): Promise<Response> {
  const chatId = msg.chat.id;
  let confirmed = 0;

  if (msg.reply_to_message) {
    const order = await findOrderByReply(chatId, msg.reply_to_message.message_id);
    if (order) confirmed = await confirmOrders(chatId, [order]);
  } else {
    const { data, error } = await db
      .from("aqvila_orders")
      .select("*")
      .eq("chat_id", chatId)
      .is("confirmed_at", null);
    if (error) throw error;
    confirmed = await confirmOrders(chatId, (data ?? []) as OrderRow[]);
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

async function sendReminders(cfg: Config, force: boolean): Promise<Response> {
  if (!force && bucharestHour() !== 15) {
    return new Response(JSON.stringify({ skipped: true, reason: "not-15-bucharest" }), {
      headers: { "content-type": "application/json" },
    });
  }

  const { data, error } = await db
    .from("aqvila_orders")
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

  const adminTag = `@${cfg.ADMIN_USERNAME}`;
  let sent = 0;

  for (const [chatId, orders] of byChat) {
    const lines = orders.map((o) => {
      const when = escapeHtml(formatBucharest(o.created_at));
      const who = escapeHtml(o.author);
      const text = escapeHtml(preview(o.text));
      const link = messageLink(o.chat_id, o.message_id);
      return `• <b>${who}</b> · ${when}\n  ${text}\n  <a href="${link}">deschide mesajul</a>`;
    });

    const html =
      `${escapeHtml(adminTag)} 📦 Necesare neconfirmate (${orders.length}):\n\n` +
      `${lines.join("\n\n")}\n\n` +
      `Le-ai transmis la Aqvila?`;

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

async function handleWebhook(req: Request, cfg: Config): Promise<Response> {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== cfg.TG_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = (await req.json()) as TgUpdate;
  if (update.update_id == null) return new Response("no-update-id", { status: 400 });

  const fresh = await claimUpdate(update.update_id);
  if (!fresh) return new Response("dup");

  const msg = update.message;
  if (!msg?.from || typeof msg.text !== "string") return new Response("skip");
  if (msg.from.is_bot) return new Response("bot");
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return new Response("not-group");

  const text = msg.text.trim();
  if (!text) return new Response("empty");
  if (text.startsWith("/")) return new Response("command");

  try {
    if (isAdmin(msg.from, cfg.ADMIN_USERNAME) && isOkText(text)) {
      return await handleAdminOk(cfg, msg);
    }

    // Admin non-ok text: ignore (don't create necesar from admin chatter)
    if (isAdmin(msg.from, cfg.ADMIN_USERNAME)) {
      return new Response("admin-skip");
    }

    const author = displayName(msg.from);
    return await handleNewNecesar(cfg, msg, author);
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
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
      return new Response("Necesar Aqvila bot ok");
    }

    if (!cfg.TG_BOT_TOKEN || !cfg.TG_WEBHOOK_SECRET) {
      return new Response("misconfigured", { status: 500 });
    }

    // Warm bot username cache (unused in hot path but useful for future @bot filters)
    await botUsername(cfg.TG_BOT_TOKEN);

    return await handleWebhook(req, cfg);
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
