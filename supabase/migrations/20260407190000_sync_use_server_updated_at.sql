-- Keep updated_at authoritative on the database side to avoid device clock skew.
create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_app_state_updated_at on public.user_app_state;
create trigger set_user_app_state_updated_at
before update on public.user_app_state
for each row
execute function public.set_updated_at_timestamp();

drop trigger if exists set_user_push_subscriptions_updated_at on public.user_push_subscriptions;
create trigger set_user_push_subscriptions_updated_at
before update on public.user_push_subscriptions
for each row
execute function public.set_updated_at_timestamp();
