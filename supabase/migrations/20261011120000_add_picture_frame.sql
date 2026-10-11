-- Register Picture Frame so its results pass the games(slug) foreign keys.
insert into public.games (slug, name)
values ('picture-frame', 'Picture Frame')
on conflict (slug) do nothing;
