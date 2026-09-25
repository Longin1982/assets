-- Necesar Aqvila bot: orders, webhook dedup, daily reminder cron
-- Project: consum-flota (existing). Free-tier-safe: pg_cron + pg_net only.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists public.aqvila_orders (
  id bigserial primary key,
  chat_id bigint not null,
  message_id bigint not null,
  tag_message_id bigint null,
  author text not null,
  text text not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz null,
  unique (chat_id, message_id)
);

create index if not exists aqvila_orders_open_by_chat_idx
  on public.aqvila_orders (chat_id)
  where confirmed_at is null;

create table if not exists public.aqvila_updates (
  update_id bigint primary key,
  created_at timestamptz not null default now()
);

-- Service-role-only config (no policies). Holds bot secrets for the edge function + cron.
create table if not exists public.aqvila_config (
  key text primary key,
  value text not null
);

alter table public.aqvila_orders enable row level security;
alter table public.aqvila_updates enable row level security;
alter table public.aqvila_config enable row level security;

revoke all on public.aqvila_orders from anon, authenticated;
revoke all on public.aqvila_updates from anon, authenticated;
revoke all on public.aqvila_config from anon, authenticated;
grant all on public.aqvila_orders to service_role;
grant all on public.aqvila_updates to service_role;
grant all on public.aqvila_config to service_role;
grant usage, select on sequence public.aqvila_orders_id_seq to service_role;

-- Unschedule previous job if present, then schedule reminder at 12:00 and 13:00 UTC.
-- Edge function checks Europe/Bucharest local hour == 15 (covers DST).
do $$
begin
  perform cron.unschedule('aqvila-reminder-15');
exception
  when others then null;
end $$;

select cron.schedule(
  'aqvila-reminder-15',
  '0 12,13 * * *',
  $$
  select net.http_post(
    url := 'https://jlkxzakemkzifjkfwiro.supabase.co/functions/v1/aqvila-bot?cron=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select value from public.aqvila_config where key = 'CRON_SECRET'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);
