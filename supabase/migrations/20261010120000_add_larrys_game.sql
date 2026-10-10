-- Register Larry's Game so its results pass the games(slug) foreign keys.
insert into public.games (slug, name)
values ('larrys-game', 'Larry’s Game')
on conflict (slug) do nothing;
