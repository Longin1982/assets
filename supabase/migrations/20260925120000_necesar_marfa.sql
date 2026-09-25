-- Necesar Marfa bot: multi-supplier orders, stitch, edits, daily reminder
-- Project: consum-flota (existing). Free-tier-safe: pg_cron + pg_net only.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Replace Aqvila-only schema with Necesar Marfa
do $$
begin
  perform cron.unschedule('aqvila-reminder-15');
exception when others then null;
end $$;

drop table if exists public.aqvila_orders cascade;
drop table if exists public.aqvila_updates cascade;
drop table if exists public.aqvila_config cascade;

create table if not exists public.suppliers (
  id serial primary key,
  name text not null unique,
  keywords text[] not null default '{}'
);

create table if not exists public.group_state (
  chat_id bigint primary key,
  active_supplier_id int null references public.suppliers(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.supplier_orders (
  id bigserial primary key,
  chat_id bigint not null,
  message_id bigint not null,
  tag_message_id bigint null,
  supplier_id int null references public.suppliers(id) on delete set null,
  author_id bigint not null,
  author text not null,
  text text not null,
  photo_file_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz null,
  unique (chat_id, message_id)
);

create index if not exists supplier_orders_open_by_chat_idx
  on public.supplier_orders (chat_id)
  where confirmed_at is null;

create table if not exists public.supplier_order_messages (
  order_id bigint not null references public.supplier_orders(id) on delete cascade,
  chat_id bigint not null,
  message_id bigint not null,
  text text not null default '',
  primary key (chat_id, message_id)
);

create index if not exists supplier_order_messages_order_idx
  on public.supplier_order_messages (order_id);

create table if not exists public.supplier_updates (
  update_id bigint primary key,
  created_at timestamptz not null default now()
);

-- Service-role-only config for edge function + cron secrets
create table if not exists public.necesar_config (
  key text primary key,
  value text not null
);

alter table public.suppliers enable row level security;
alter table public.group_state enable row level security;
alter table public.supplier_orders enable row level security;
alter table public.supplier_order_messages enable row level security;
alter table public.supplier_updates enable row level security;
alter table public.necesar_config enable row level security;

revoke all on public.suppliers from anon, authenticated;
revoke all on public.group_state from anon, authenticated;
revoke all on public.supplier_orders from anon, authenticated;
revoke all on public.supplier_order_messages from anon, authenticated;
revoke all on public.supplier_updates from anon, authenticated;
revoke all on public.necesar_config from anon, authenticated;

grant all on public.suppliers to service_role;
grant all on public.group_state to service_role;
grant all on public.supplier_orders to service_role;
grant all on public.supplier_order_messages to service_role;
grant all on public.supplier_updates to service_role;
grant all on public.necesar_config to service_role;
grant usage, select on sequence public.suppliers_id_seq to service_role;
grant usage, select on sequence public.supplier_orders_id_seq to service_role;

insert into public.suppliers (name, keywords) values
  ('Aqvila', array['aqvila','acvila']),
  ('Imdia', array['imdia']),
  ('Ocean Fish', array['ocean fish','oceanfish']),
  ('Olimpic', array['olimpic'])
on conflict (name) do update set keywords = excluded.keywords;

do $$
begin
  perform cron.unschedule('necesar-reminder-15');
exception when others then null;
end $$;

select cron.schedule(
  'necesar-reminder-15',
  '0 12,13 * * *',
  $$
  select net.http_post(
    url := 'https://jlkxzakemkzifjkfwiro.supabase.co/functions/v1/necesar-bot?cron=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select value from public.necesar_config where key = 'CRON_SECRET'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  );
  $$
);
