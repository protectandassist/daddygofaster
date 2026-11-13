# dgf-bids

The bid service behind daddygofaster.com. A Cloudflare Worker with a D1 database.
Live at `https://dgf-bids.trevor-c2b.workers.dev`.

The site's page (`../index.html`) calls two public endpoints. The owner uses `/admin`.

| Endpoint | Who | What |
|---|---|---|
| `GET /board` | anyone | Bids that passed the screen: name, amount, time. Never the job or the email. |
| `POST /bids` | anyone | Place a bid. Answers `qualified`, `short`, `held` or `refused` with a message. |
| `GET /admin` | owner | The owner's page. Asks for the admin key. |
| `/admin/api/*` | owner | Needs `Authorization: Bearer <ADMIN_KEY>`. |

## How a bid is handled

1. The bid is checked for shape and against the limits: 5 landed bids per email per day,
   30 per network address per hour, one win per person per week.
2. The screen reads the job and the name (`src/screen.js`). It answers allow, refuse or
   unsure, and estimates minutes and costs. It never writes the bidder's reply.
3. `src/rules.js` turns that into a verdict:
   - **refused**: the job or the name breaks a house rule.
   - **held**: the screen was unsure, the job needs a real quote (flights, hotels), the
     screen failed, or there is no AI key. A person approves or refuses it in `/admin`.
   - **short**: the bid does not cover the job at $200 an hour. The reply says what would.
   - **qualified**: it goes on the board.
   A job that takes under a minute is covered by any bid. That is what lets one cent win.
4. A new high bid in the last five minutes moves the close back five minutes, at most
   twelve times.

Bidding for a job day closes at 8 p.m. Central the evening before, and the next round
opens straight away. There is no scheduler: a round that has run past its close is
settled the next time anyone loads the board, bids, or opens `/admin`. The highest
qualifying bid wins and the earlier bid wins a tie.

## What the owner has to set

In the Cloudflare dashboard: Workers & Pages > dgf-bids > Settings > Variables and
Secrets. Add each as type **Secret**.

| Secret | Needed | What it is |
|---|---|---|
| `ADMIN_KEY` | yes | Any long random string. It is the password for `/admin`. |
| `ANTHROPIC_API_KEY` | no | Turns on the AI screen. Without it, every bid waits for approval in `/admin`. |

Everything else is a plain setting in `wrangler.toml`: the rate, the close hour and time
zone, the daily limit, the sites allowed to call the service, and the model.

## Opening and closing bidding

`OPEN` in `wrangler.toml` is the master switch. While it is not `"true"` the board says
`soon`, bids are refused, and nothing is written to the database. Change it and deploy:

```sh
npm run deploy
```

## Payment

Not built yet. When a round closes, `/admin` shows the winner, their email, the amount
and the estimated costs. The owner collects payment and costs however they like before
doing the job. "Winner did not pay" in `/admin` passes the day to the next bid.

## The owner's page

`/admin` shows bids waiting for a person, every bid in the current round, and the last
winner. Jobs are hidden unless "Show the jobs" is ticked, so the owner can stay
surprised. Someone should still read the winning job before it is done.

## Working on it

```sh
npm install
npm test                 # the rules, as unit tests
npm run migrate:local    # create the tables in a local database
npm run dev              # run locally on http://localhost:8787
```

For local runs put `ADMIN_KEY=anything` in `.dev.vars` (ignored by git) and start with
`npx wrangler dev --var OPEN:true`.

Deploying needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.
New tables or columns go in a new file under `migrations/`, applied with
`npm run migrate:remote`.

## The AI screen

One Claude call per bid, using the model in `SCREEN_MODEL`. The call asks for a fixed
JSON shape and low effort. If the model declines, errors or times out, the bid is held
for a person; it is never allowed by default. The call has not been run against the real
API yet: it was tested against a local stand-in that returns the same response shape.
