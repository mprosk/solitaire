# Vendored supabase-js

`@supabase/supabase-js` and its dependencies, from jsDelivr's `+esm` builds. Each
`/npm/<pkg>@<version>/+esm` import is rewritten to `./<pkg>-<version>.js`, so the site
loads no third-party script at runtime.

To upgrade, run `python3 scripts/vendor-supabase.py <version>`, then change the import
in `lib/supabase.js` to the new `supabase-js-<version>.js`.
