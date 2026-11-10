create extension if not exists pgcrypto;

-- PRODUCTS ------------------------------------------------------------
create table if not exists products (
  id text primary key,
  source text default 'dummyjson',
  source_id int,
  name text not null,
  description text,
  brand text,
  category text,
  tags text[] default '{}',
  list_price numeric(10,2),
  discount_percentage numeric(5,2) default 0,
  price numeric(10,2) not null check (price > 0),   -- FINAL selling price
  currency text default 'USD',
  rating numeric(3,2),
  stock int default 0,
  thumbnail_url text,
  image_urls text[] default '{}',
  created_at timestamptz default now(),
  search_vector tsvector
);
create index if not exists products_category_idx on products(category);
create index if not exists products_search_idx on products using gin(search_vector);

create or replace function products_tsv_update() returns trigger language plpgsql as $$
begin
  new.search_vector := to_tsvector('english',
    coalesce(new.name,'') || ' ' || coalesce(new.description,'') || ' ' ||
    coalesce(new.brand,'') || ' ' || coalesce(array_to_string(new.tags,' '),''));
  return new;
end $$;
drop trigger if exists products_tsv on products;
create trigger products_tsv before insert or update on products
  for each row execute function products_tsv_update();

-- OTHER TABLES --------------------------------------------------------
create table if not exists paypal_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  vault_customer_id text,
  payment_token_id text,
  setup_token_id text,
  status text not null check (status in ('PENDING','ACTIVE','REMOVED')),
  updated_at timestamptz default now()
);
create table if not exists user_settings (
  user_id uuid primary key,
  per_order_limit numeric default 50,
  daily_limit numeric default 100
);
create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  items jsonb not null,
  total numeric(10,2) not null,
  currency text not null,
  expires_at timestamptz not null,
  used boolean default false
);
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  paypal_order_id text unique,
  capture_id text,
  status text not null,
  total numeric(10,2) not null,
  currency text not null,
  items jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists orders_user_idx on orders(user_id, created_at desc);
create index if not exists orders_capture_idx on orders(capture_id);
create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) on delete set null,
  event_type text not null,
  payload jsonb,
  created_at timestamptz default now()
);
create table if not exists mcp_tool_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  tool_name text not null,
  input jsonb,
  ok boolean,
  created_at timestamptz default now()
);

-- RLS: public products, users read only their own rows. Writes = service role only.
alter table products enable row level security;
alter table paypal_accounts enable row level security;
alter table user_settings enable row level security;
alter table quotes enable row level security;
alter table orders enable row level security;
alter table payment_events enable row level security;
alter table mcp_tool_logs enable row level security;

drop policy if exists "products public read" on products;
create policy "products public read" on products for select using (true);
drop policy if exists "own paypal_accounts" on paypal_accounts;
create policy "own paypal_accounts" on paypal_accounts for select using (auth.uid() = user_id);
drop policy if exists "own user_settings" on user_settings;
create policy "own user_settings" on user_settings for select using (auth.uid() = user_id);
drop policy if exists "own quotes" on quotes;
create policy "own quotes" on quotes for select using (auth.uid() = user_id);
drop policy if exists "own orders" on orders;
create policy "own orders" on orders for select using (auth.uid() = user_id);
drop policy if exists "own payment_events" on payment_events;
create policy "own payment_events" on payment_events for select
  using (exists (select 1 from orders o where o.id = order_id and o.user_id = auth.uid()));
drop policy if exists "own mcp_tool_logs" on mcp_tool_logs;
create policy "own mcp_tool_logs" on mcp_tool_logs for select using (auth.uid() = user_id);

-- Vault token ids must never be readable through the public API, even by their owner.
revoke select on paypal_accounts from anon, authenticated;
grant select (user_id, status, updated_at) on paypal_accounts to authenticated;

-- FUNCTIONS (called by the backend with the service role) -------------
create or replace function search_products(
  q text, cat text, minp numeric, maxp numeric, instock boolean, lim int
) returns setof products language sql stable as $$
  select p.* from products p
  where (q is null or q = ''
         or p.search_vector @@ websearch_to_tsquery('english', q)
         or p.name ilike '%' || q || '%'
         or coalesce(p.brand,'') ilike '%' || q || '%'
         or coalesce(p.category,'') ilike '%' || q || '%'
         or array_to_string(p.tags,' ') ilike '%' || q || '%')
    and (cat is null or p.category = cat)
    and (minp is null or p.price >= minp)
    and (maxp is null or p.price <= maxp)
    and (not coalesce(instock,false) or p.stock > 0)
  order by case when q is null or q = '' then 0
                else ts_rank(p.search_vector, websearch_to_tsquery('english', q)) end desc,
           p.rating desc nulls last
  limit least(greatest(coalesce(lim,10),1), 20)
$$;

create or replace function decrement_stock(p_id text, qty int) returns boolean
language plpgsql as $$
begin
  update products set stock = stock - qty where id = p_id and stock >= qty;
  return found;
end $$;
revoke execute on function decrement_stock(text, int) from public, anon, authenticated;
