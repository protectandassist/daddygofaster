# daddygofaster.com

Single-page site for **DaddyGoFaster**, served by GitHub Pages from `main`.

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole site — markup, CSS, and JS in one file. No build step. |
| `404.html` | "Red light" error page. |
| `CNAME` | Maps the site to `daddygofaster.com`. **Do not delete.** |
| `.nojekyll` | Tells Pages to serve files as-is instead of running Jekyll. |
| `assets/` | Hero photo (jpg + webp, full and small), Open Graph card, favicons. |
| `robots.txt`, `sitemap.xml` | Search engine basics. |

## Editing

Open `index.html` and change the text. The parts most likely to need swapping:

- **Hero** — headline, the one-line description, the `Ride along` button target.
- **60 FT / 330 FT** — the three crew roles and the three "what we get up to" cards.
- **660 FT** — the timing slip. Each `slip__row` is one house rule; add or remove rows freely.
- **1320 FT** — the signup. It currently opens the visitor's mail client to
  `hello@daddygofaster.com`. Point `action` at a real form endpoint when there is one.

Design tokens (every color in the site) live in the `:root` block at the top of the
`<style>` tag, so a palette change is a handful of hex values.

## Local preview

```sh
python -m http.server 8899
```

Then open <http://127.0.0.1:8899/>. Paths are absolute (`/assets/...`), so preview from
the repo root rather than opening `index.html` off the filesystem.

## Deploying

Push to `main`. GitHub Pages rebuilds automatically.

## Custom domain

DNS for `daddygofaster.com` must point at GitHub:

```
A     @     185.199.108.153
A     @     185.199.109.153
A     @     185.199.110.153
A     @     185.199.111.153
AAAA  @     2606:50c0:8000::153
AAAA  @     2606:50c0:8001::153
AAAA  @     2606:50c0:8002::153
AAAA  @     2606:50c0:8003::153
CNAME www   protectandassist.github.io
```
