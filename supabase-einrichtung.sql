-- =====================================================================
-- Kundendatenbank Schulungen – Datenbank-Einrichtung für Supabase
-- Einmalig im Supabase-Dashboard unter "SQL Editor" einfügen und "Run".
-- =====================================================================

-- ---------- Kunden ----------
create table if not exists public.kunden (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(trim(name)) > 0),
  ansprechpartner  text not null default '',
  telefon          text not null default '',
  email            text not null default '',
  kundennr         text not null default '',
  strasse          text not null default '',
  ort              text not null default '',
  notizen          text not null default '',
  erstellt_am      timestamptz not null default now(),
  geaendert_am     timestamptz not null default now()
);

-- ---------- Termine ----------
create table if not exists public.termine (
  id                  uuid primary key default gen_random_uuid(),
  kunde_id            uuid not null references public.kunden(id) on delete restrict,
  datum               date not null,
  uhrzeit             text not null default '',
  ort                 text not null default '',
  teilnehmer          integer check (teilnehmer is null or teilnehmer >= 0),
  schulungsart        text not null default '',
  status              text not null default 'geplant'
                      check (status in ('geplant','durchgefuehrt','abgesagt')),
  notizen             text not null default '',
  -- Bericht
  bericht_status      text not null default 'offen'
                      check (bericht_status in ('offen','erledigt','entfaellt')),
  bericht_datum       date,
  bericht_info        text not null default '',
  -- Schulungsbescheinigungen
  besch_status        text not null default 'offen'
                      check (besch_status in ('offen','erledigt','entfaellt')),
  besch_datum         date,
  besch_anzahl        integer check (besch_anzahl is null or besch_anzahl >= 0),
  besch_info          text not null default '',
  -- Rechnungslegung
  rechnung_status     text not null default 'offen'
                      check (rechnung_status in ('offen','erledigt','entfaellt')),
  rechnung_datum      date,
  rechnung_nr         text not null default '',
  rechnung_betrag     numeric(12,2),
  bezahlt_am          date,
  erstellt_am         timestamptz not null default now(),
  geaendert_am        timestamptz not null default now()
);

create index if not exists termine_kunde_idx on public.termine(kunde_id);
create index if not exists termine_datum_idx on public.termine(datum);

-- ---------- Änderungszeitpunkt automatisch setzen ----------
create or replace function public.set_geaendert_am()
returns trigger language plpgsql as $$
begin
  new.geaendert_am := now();
  return new;
end $$;

drop trigger if exists kunden_geaendert on public.kunden;
create trigger kunden_geaendert before update on public.kunden
  for each row execute function public.set_geaendert_am();

drop trigger if exists termine_geaendert on public.termine;
create trigger termine_geaendert before update on public.termine
  for each row execute function public.set_geaendert_am();

-- ---------- Zugriffsschutz (Row Level Security) ----------
-- Nur angemeldete Benutzer Ihres Projekts dürfen lesen und schreiben.
-- Nicht angemeldete Zugriffe (auch mit dem öffentlichen Schlüssel) sehen nichts.
alter table public.kunden  enable row level security;
alter table public.termine enable row level security;

drop policy if exists "Angemeldete Benutzer – Kunden"  on public.kunden;
drop policy if exists "Angemeldete Benutzer – Termine" on public.termine;

create policy "Angemeldete Benutzer – Kunden" on public.kunden
  for all to authenticated using (true) with check (true);

create policy "Angemeldete Benutzer – Termine" on public.termine
  for all to authenticated using (true) with check (true);

revoke all on public.kunden, public.termine from anon;
grant select, insert, update, delete on public.kunden, public.termine to authenticated;

-- ---------- Echtzeit-Synchronisation zwischen allen Geräten ----------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'kunden') then
    alter publication supabase_realtime add table public.kunden;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'termine') then
    alter publication supabase_realtime add table public.termine;
  end if;
end $$;

-- Fertig. Weiter mit Schritt 3 der Anleitung (Benutzer anlegen).
