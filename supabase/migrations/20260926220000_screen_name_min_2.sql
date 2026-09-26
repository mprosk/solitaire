-- Allow shorter display names (2–24).
alter table public.profiles drop constraint if exists profiles_screen_name_length_check;

alter table public.profiles
  add constraint profiles_screen_name_length_check
  check (
    screen_name is null
    or char_length(screen_name) between 2 and 24
  );
