-- ============================================================================
-- Normaliza mapa_config (units/doctors/attendants/priceEntries) em tabelas
-- próprias. NÃO apaga nem altera mapa_config — roda em paralelo para você
-- conferir os dados antes de decidir migrar o app para usar as tabelas novas.
--
-- Ordem de execução importa (units -> rooms/attendants -> doctors -> price_entries)
-- por causa das foreign keys. Rode o arquivo inteiro de uma vez no SQL Editor
-- do Supabase.
-- ============================================================================

-- 1. UNIDADES ----------------------------------------------------------------
create table if not exists public.units (
  id       text primary key,
  name     text not null,
  archived boolean not null default false
);

-- 2. SALAS --------------------------------------------------------------------
create table if not exists public.rooms (
  id             text primary key,
  unit_id        text not null references public.units(id) on delete cascade,
  name           text not null,
  archived       boolean not null default false,
  archived_from  date
);

-- 3. ATENDENTES ----------------------------------------------------------------
create table if not exists public.attendants (
  id      text primary key,
  name    text not null,
  unit_id text references public.units(id) on delete set null
);

-- 4. MÉDICOS --------------------------------------------------------------------
create table if not exists public.doctors (
  id               text primary key,
  name             text not null,
  spec             text,
  type             text,            -- 'ordem' | 'hora'
  unit_id          text references public.units(id) on delete set null,
  attendant_id     text references public.attendants(id) on delete set null,
  archived         boolean not null default false,
  default_nature   text,
  price_cartao     text,            -- mantido como texto: dados atuais misturam "80", "80,00", "-", null
  price_particular text,
  convenios        jsonb not null default '[]'::jsonb,
  procedimentos    jsonb not null default '[]'::jsonb,
  real_clinic_id   text
);

-- 5. TABELA DE PREÇOS ------------------------------------------------------------
create table if not exists public.price_entries (
  id               text primary key,
  label            text,
  nature           text,
  service_label    text,
  unit_id          text references public.units(id) on delete cascade,
  doctor_id        text references public.doctors(id) on delete set null,
  price_cartao     text,
  price_particular text
);

-- ============================================================================
-- MIGRAÇÃO DOS DADOS ATUAIS (lidos direto do jsonb existente em mapa_config)
-- ============================================================================

-- Unidades
insert into public.units (id, name, archived)
select
  elem->>'id',
  elem->>'name',
  coalesce((elem->>'archived')::boolean, false)
from public.mapa_config, jsonb_array_elements(data) as elem
where mapa_config.id = 'units'
on conflict (id) do nothing;

-- Salas (aninhadas dentro de units[].rooms)
insert into public.rooms (id, unit_id, name, archived, archived_from)
select
  room->>'id',
  u->>'id',
  room->>'name',
  coalesce((room->>'archived')::boolean, false),
  nullif(room->>'archivedFrom', '')::date
from public.mapa_config,
     jsonb_array_elements(data) as u,
     jsonb_array_elements(coalesce(u->'rooms', '[]'::jsonb)) as room
where mapa_config.id = 'units'
on conflict (id) do nothing;

-- Atendentes
insert into public.attendants (id, name, unit_id)
select elem->>'id', elem->>'name', elem->>'unitId'
from public.mapa_config, jsonb_array_elements(data) as elem
where mapa_config.id = 'attendants'
on conflict (id) do nothing;

-- Médicos
-- attendant_id é anulado quando o atendente referenciado não existe mais em
-- public.attendants (dados atuais têm médicos apontando pra atendentes já
-- removidos) — sem essa guarda, a FK derruba a migração inteira numa linha só.
insert into public.doctors (
  id, name, spec, type, unit_id, attendant_id, archived,
  default_nature, price_cartao, price_particular, convenios, procedimentos, real_clinic_id
)
select
  elem->>'id',
  elem->>'name',
  elem->>'spec',
  elem->>'type',
  elem->>'unitId',
  case when exists (select 1 from public.attendants a where a.id = elem->>'attendantId')
       then elem->>'attendantId' else null end,
  coalesce((elem->>'archived')::boolean, false),
  elem->>'defaultNature',
  elem->>'priceCartao',
  elem->>'priceParticular',
  coalesce(elem->'convenios', '[]'::jsonb),
  coalesce(elem->'procedimentos', '[]'::jsonb),
  elem->>'realClinicId'
from public.mapa_config, jsonb_array_elements(data) as elem
where mapa_config.id = 'doctors'
on conflict (id) do nothing;

-- Tabela de preços
-- (usa ON CONFLICT DO NOTHING porque o array atual tem pelo menos 1 id duplicado
--  — ex.: "pe_main_d1778699079162" aparece 2x — o app já roda deduplicatePriceEntries()
--  no carregamento por causa disso. doctor_id segue a mesma guarda de existência
--  usada acima em attendant_id, pelo mesmo motivo: há entradas de preço apontando
--  pra médicos que já não existem mais no array atual.)
insert into public.price_entries (
  id, label, nature, service_label, unit_id, doctor_id, price_cartao, price_particular
)
select
  elem->>'id',
  elem->>'label',
  elem->>'nature',
  elem->>'serviceLabel',
  elem->>'unitId',
  case when exists (select 1 from public.doctors d where d.id = elem->>'doctorId')
       then elem->>'doctorId' else null end,
  elem->>'priceCartao',
  elem->>'priceParticular'
from public.mapa_config, jsonb_array_elements(data) as elem
where mapa_config.id = 'priceEntries'
on conflict (id) do nothing;

-- Conferir quantas referências foram anuladas por não existirem mais (opcional):
-- select elem->>'id' as price_entry_id, elem->>'doctorId' as doctor_id_orfao
-- from public.mapa_config, jsonb_array_elements(data) as elem
-- where mapa_config.id = 'priceEntries'
--   and elem->>'doctorId' is not null
--   and not exists (select 1 from public.doctors d where d.id = elem->>'doctorId');

-- ============================================================================
-- CONFERÊNCIA — rode depois de migrar para comparar quantidades
-- ============================================================================
-- select
--   (select jsonb_array_length(data) from mapa_config where id='units')        as units_json,
--   (select count(*) from public.units)                                        as units_table,
--   (select jsonb_array_length(data) from mapa_config where id='doctors')      as doctors_json,
--   (select count(*) from public.doctors)                                      as doctors_table,
--   (select jsonb_array_length(data) from mapa_config where id='attendants')   as attendants_json,
--   (select count(*) from public.attendants)                                   as attendants_table,
--   (select jsonb_array_length(data) from mapa_config where id='priceEntries') as price_json,
--   (select count(*) from public.price_entries)                                as price_table;
