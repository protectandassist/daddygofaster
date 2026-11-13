# daddygofaster.com

The **DaddyGoFaster** bid site, served by GitHub Pages from `main`.

The idea: every day people bid on what the owner does tomorrow. Bids start at one cent.
Amounts are public, the job stays sealed until the video. The highest bid that covers its
job wins, and only the winner pays.

## Status

The page is built. **Bidding is not switched on.** Until a bid service exists and its
address is set in `index.html`, the page says "Bidding opens soon" and the form's only
button opens an email asking to be told when it does. Nothing a visitor types is sent to a
server.

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole bid site: markup, CSS, and JS in one file. No build step. |
| `legacy/index.html` | The original DaddyGoFaster home page (YouTube and Etsy), set aside unchanged. Still reachable at `/legacy/`, not linked, and excluded in `robots.txt`. |
| `404.html` | "Wrong exit" error page. |
| `CNAME` | Maps the site to `daddygofaster.com`. **Do not delete.** |
| `.nojekyll` | Tells Pages to serve files as-is instead of running Jekyll. |
| `assets/` | Favicons, share card (`og-bid.jpg`), and the images the legacy page uses. |
| `robots.txt`, `sitemap.xml` | Search engine basics. |

## The rules the page states

These came from the owner. Change the wording in `index.html` (sections `#how`, `#covers`,
`#rules`) if a rule changes; the bid service has to enforce the same thing.

- A bid is a job plus an amount. The floor is 1¢.
- A bid only qualifies if it covers the job at about **$200 an hour**, with travel counted
  both ways. This is a sanity check, not a meter: there is no clock on the job.
- Costs (fares, tickets, flights) are on top and paid up front. Flights and hotels need a
  real quote.
- Highest qualifying bid wins. Only the winner pays. A win under 50¢ is free.
- One win per person per week, and a daily limit on bids per person.
- Bidding closes the night before. A bid in the last five minutes adds five minutes.
- If the winner does not pay in time, the next bid wins.
- Allowed: hard, boring, early, inconvenient, kind. Refused: illegal, dangerous, sexual,
  costumes or appearance changes, scripted speech, politics, religion, product plugs,
  anything aimed at a person or private address, public scenes, family, live locations.
- An AI screens every bid and name first. Anything it is unsure of goes to a person.

## Switching bidding on

Near the top of the `<script>` in `index.html`:

```js
var CONFIG = { api: "", rate: 200, freeUnderCents: 50 };
```

Set `api` to the bid service's base URL (no trailing slash). The page then expects:

**`GET {api}/board`**

```json
{
  "status": "open",
  "closesAt": "2026-11-14T02:00:00Z",
  "bids": [ { "name": "backseat_driver", "amountCents": 4200, "placedAt": "2026-11-13T21:40:00Z" } ]
}
```

`status` is `open`, `closed`, or `soon`. Only bids that passed the screen belong in
`bids`. Never include the job text or the email: this response is public.

**`POST {api}/bids`** with `{ "task", "name", "email", "amountCents" }`

```json
{ "verdict": "short", "message": "That is about 50 minutes door to door, so it needs $166.67...", "minCents": 16667 }
```

`verdict` is `qualified`, `short` (bid does not cover the job), `held` (waiting on a
person), or `refused`. `message` is shown to the bidder as plain text.

The service needs CORS enabled for `https://daddygofaster.com`.

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
