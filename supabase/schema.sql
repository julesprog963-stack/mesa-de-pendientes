-- Ejecuta este script en el SQL Editor de tu proyecto en Supabase:

create table if not exists public.mesa_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.mesa_kv enable row level security;

-- Bucket privado para los PDFs y evidencias adjuntas de los tickets
insert into storage.buckets (id, name, public)
values ('mesa-uploads', 'mesa-uploads', false)
on conflict (id) do nothing;
