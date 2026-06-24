-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query)

create table if not exists game_rooms (
  code text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table game_rooms enable row level security;

-- Anyone with the anon key can read/create/update rooms. This is fine for a
-- casual party game with friends, but be aware: there is no per-room
-- password, so anyone who has (or guesses) the room code can join and edit it.
create policy "Anyone can read rooms" on game_rooms
  for select using (true);

create policy "Anyone can create rooms" on game_rooms
  for insert with check (true);

create policy "Anyone can update rooms" on game_rooms
  for update using (true);

-- Enable realtime change notifications for this table
alter publication supabase_realtime add table game_rooms;
