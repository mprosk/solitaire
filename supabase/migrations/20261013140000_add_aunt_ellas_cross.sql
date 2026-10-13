-- Register Aunt Ella's Cross so its results pass the games(slug) foreign keys.
-- A win puts all 52 cards up, so the default win-score check already fits.
insert into public.games (slug, name)
values ('aunt-ellas-cross', 'Aunt Ella’s Cross')
on conflict (slug) do nothing;
