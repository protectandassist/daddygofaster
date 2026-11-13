# daddygofaster.com

The **DaddyGoFaster** bid site, served by GitHub Pages from `main`.

The idea: every day people bid on what the owner does tomorrow. Bids start at one cent.
Amounts are public, the job stays sealed until the video. The highest bid that covers its
job wins, and only the winner pays.

## Status

The page and the bid service are both built. **Bidding is switched off** in the service
(`OPEN = "false"` in `service/wrangler.toml`), so the page says "Bidding opens soon" and
the form's only button opens an email asking to be told when it does.

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole bid site: markup, CSS, and JS in one file. No build step. |
| `legacy/index.html` | The original DaddyGoFaster home page (YouTube and Etsy), set aside unchanged. Still reachable at `/legacy/`, not linked, and excluded in `robots.txt`. |
| `404.html` | "Wrong exit" error page. |
| `CNAME` | Maps the site to `daddygofaster.com`. **Do not delete.** |
| `.nojekyll` | Tells Pages to serve files as-is instead of running Jekyll. |
| `assets/` | Favicons, share card (`og-bid.jpg`), and the images the legacy page uses. |
| `service/` | The bid service: a Cloudflare Worker and its database schema. See `service/README.md`. |
| `robots.txt`, `sitemap.xml` | Search engine basics. |

## The rules the page states

These came from the owner. Change the wording in `index.html` (sections `#how`, `#covers`,
`#rules`) if a rule changes; the bid service has to enforce the same thing.

- A bid is a job plus an amount. The floor is 1¢.
- A bid only qualifies if it covers the job at about **$200 an hour**, with travel counted
  both ways. This is a sanity check, not a meter: there is no clock on the job. A job
  that takes seconds is covered by any bid.
- Costs (fares, tickets, flights) are on top and paid up front. Flights and hotels need a
  real quote.
- Highest qualifying bid wins. Only the winner pays. A win under 50¢ is free.
- One win per person per week, and a daily limit on bids per person.
- Bidding closes the night before. A new high bid in the last five minutes adds five
  minutes, up to an hour in total.
- If the winner does not pay in time, the next bid wins.
- Allowed: hard, boring, early, inconvenient, kind. Refused: illegal, dangerous, sexual,
  costumes or appearance changes, scripted speech, politics, religion, product plugs,
  anything aimed at a person or private address, public scenes, family, live locations.
- An AI screens every bid and name first. Anything it is unsure of goes to a person.

## The bid service

`service/` is a Cloudflare Worker with a D1 database, live at
`https://dgf-bids.trevor-c2b.workers.dev`. `service/README.md` covers how bids are
screened, the owner's page, the two secrets the owner sets, and how to open bidding.

The page finds it through one line near the top of the `<script>` in `index.html`:

```js
var CONFIG = { api: "https://dgf-bids.trevor-c2b.workers.dev", rate: 200, freeUnderCents: 50 };
```

`GET {api}/board` tells the page whether bidding is `open`, `closed` or `soon`, when it
closes, and the bids to list. `POST {api}/bids` takes `{ task, name, email, amountCents }`
and answers with a `verdict` and a `message` that the page shows as plain text. If the
service cannot be reached the page stays in its not-open state.

GitHub Pages serves every file in this repository, so the service's source is readable
at `/service/...`. It holds no secrets.

## Previewing with sample bids

Add `?demo` to the address (`http://127.0.0.1:8899/?demo`). The board fills with clearly
labelled sample bids and a running countdown, and the form answers "This is a preview, so
nothing was sent." Demo mode never contacts a server.

## Local preview

```sh
python -m http.server 8899
```

Then open <http://127.0.0.1:8899/>. Paths are absolute (`/assets/...`), so preview from
the repo root rather than opening `index.html` off the filesystem.

## Editing

Design tokens (every color in the site) live in the `:root` block at the top of the
`<style>` tag. The sponsor spots are the two `.spot` blocks in `#sponsors`; the first is
the Protect & Assist house ad, whose one-line description is copied from the Protect &
Assist home page and should stay in step with it.

The page is written to get a visitor to bid: the bid form is the first thing on screen,
every section ends near a "Place a bid" button, and phones get a fixed bid bar. Keep the
wording plain. Section headings say what the section is; no slogans.

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
