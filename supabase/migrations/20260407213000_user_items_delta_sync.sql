-- Item-level delta sync table to avoid whole-snapshot overwrites.
create table if not exists public.user_items (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null,
  payload jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, item_id)
);

create index if not exists user_items_user_idx on public.user_items (user_id);
create index if not exists user_items_updated_idx on public.user_items (updated_at desc);

alter table public.user_items enable row level security;

create policy "user_items_select_own"
  on public.user_items for select
  using (auth.uid() = user_id);

create policy "user_items_insert_own"
  on public.user_items for insert
  with check (auth.uid() = user_id);

create policy "user_items_update_own"
  on public.user_items for update
  using (auth.uid() = user_id);

create policy "user_items_delete_own"
  on public.user_items for delete
  using (auth.uid() = user_id);

drop trigger if exists set_user_items_updated_at on public.user_items;
create trigger set_user_items_updated_at
before update on public.user_items
for each row
execute function public.set_updated_at_timestamp();
