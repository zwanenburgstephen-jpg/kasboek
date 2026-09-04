-- Kasboek — database-inrichting voor Supabase.
-- Plak dit in de SQL Editor van je Supabase-project en klik op "Run". Eén keer uitvoeren is genoeg.

-- 1. De tabel: één rij per document (rekeningen-config, vaste last, maand, lening, bezitting).
create table if not exists public.kasboek_docs (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  collection  text        not null check (collection in ('config', 'recurring', 'months', 'loans', 'assets')),
  id          text        not null,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, collection, id)
);

-- 2. Alleen de eigenaar mag zijn eigen rijen zien en bewerken (Row Level Security).
alter table public.kasboek_docs enable row level security;

drop policy if exists "kasboek: eigen rijen lezen"      on public.kasboek_docs;
drop policy if exists "kasboek: eigen rijen toevoegen"  on public.kasboek_docs;
drop policy if exists "kasboek: eigen rijen wijzigen"   on public.kasboek_docs;
drop policy if exists "kasboek: eigen rijen verwijderen" on public.kasboek_docs;

create policy "kasboek: eigen rijen lezen"       on public.kasboek_docs for select using (auth.uid() = user_id);
create policy "kasboek: eigen rijen toevoegen"   on public.kasboek_docs for insert with check (auth.uid() = user_id);
create policy "kasboek: eigen rijen wijzigen"    on public.kasboek_docs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "kasboek: eigen rijen verwijderen" on public.kasboek_docs for delete using (auth.uid() = user_id);

-- 3. Rechten voor ingelogde gebruikers (de anon-rol krijgt niets: zonder login is er geen toegang).
revoke all on public.kasboek_docs from anon;
grant select, insert, update, delete on public.kasboek_docs to authenticated;

-- 4. Handig voor overzicht in het Table-dashboard.
create index if not exists kasboek_docs_user_coll_idx on public.kasboek_docs (user_id, collection);
