-- Web Push 購読情報（ユーザー自身のみ参照/更新）
create table if not exists public.user_push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  subscription jsonb not null,
  user_agent text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

create index if not exists user_push_subscriptions_user_idx on public.user_push_subscriptions (user_id);
create index if not exists user_push_subscriptions_updated_idx on public.user_push_subscriptions (updated_at desc);

alter table public.user_push_subscriptions enable row level security;

create policy "user_push_subscriptions_select_own"
  on public.user_push_subscriptions for select
  using (auth.uid() = user_id);

create policy "user_push_subscriptions_insert_own"
  on public.user_push_subscriptions for insert
  with check (auth.uid() = user_id);

create policy "user_push_subscriptions_update_own"
  on public.user_push_subscriptions for update
  using (auth.uid() = user_id);

create policy "user_push_subscriptions_delete_own"
  on public.user_push_subscriptions for delete
  using (auth.uid() = user_id);
