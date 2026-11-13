# dgf-bids

The bid service behind daddygofaster.com. A Cloudflare Worker with a D1 database.
Live at `https://dgf-bids.trevor-c2b.workers.dev`.

The site's page (`../index.html`) calls two public endpoints. The owner uses `/admin`.

| Endpoint | Who | What |
|---|---|---|
| `GET /board` | anyone | Bids that passed the screen: name, amount, time. Never the job or the email. |
| `POST /bids` | anyone | Place a bid or raise one. Answers `qualified`, `short`, `held` or `refused` with a message. |
| `POST /mine` | the bidder's browser | How the bids that browser placed are standing: leading, outbid, waiting, short, won. |
| `GET /stop` | the bidder | The link in an outbid email. Turns those emails off for that bid. |
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
4. A new high bid in the last five minutes moves the close back five minutes. There is
   no cap: while people keep outbidding each other, the round stays open.

**Raising a bid.** The same email sending the same job again raises that bid, and so
does the page sending the bid's private handle. The bid or its maximum has to go up, and
neither can come down. There is no new screen and no new row, it does not count against the daily
limit, and the same $200-an-hour check applies, so a bid that fell short qualifies once
it is raised far enough.

Bidding for a job day closes at 8 p.m. Central the evening before, and the next round
opens straight away. There is no scheduler: a round that has run past its close is
settled the next time anyone loads the board, bids, or opens `/admin`. The highest
qualifying bid wins and the earlier bid wins a tie.

## Auto-bid

A bid can carry a hidden maximum. The bid then rises on its own, one cent over the next
bid, whenever someone outbids it, and stops at the maximum. Two maximums answer each
other at once: the higher one leads at one cent over the lower. If a bid starts below what
its job needs and its maximum reaches that amount, it goes up to exactly that amount.
The maximum is never shown: not on the board, and not on the owner's page.

## Telling a bidder they were outbid

- **On the page.** The service gives each bid a private handle and the bidder's browser
  keeps it. The page shows "You are leading" or "You have been outbid" with a Raise button,
  and checks again every 30 seconds. This needs nothing set up.
- **By email.** When an email key is set, the bid form offers "Email me if I am outbid".
  The bidder who loses the lead gets one email, at most three per bid per round and no
  more than one every ten minutes, each with a link to stop them. Email goes through
  Resend, from the address in `MAIL_FROM`, whose domain has to be verified with Resend.
  This has only been run against a local stand-in, not against Resend itself.

## Keys

No key is typed into a chat, a command line or this repository.

| Key | Needed | Where it lives |
|---|---|---|
| `VAULT_KEY` | yes | A Worker secret, set once at random. It seals the email and AI keys in the database. |
| admin key | yes | The password for `/admin`. Stored as a salted hash, so the key itself is not kept. |
| email key | no | A Resend API key. Stored sealed. Turns on outbid emails. |
| AI key | no | An Anthropic API key. Stored sealed. Without it every bid waits for approval in `/admin`. |

The last three go in through `POST /admin/api/setup`, as the request headers
`X-Admin-Key`, `X-Mail-Key` and `X-Ai-Key`. The call only works while a one-time code is
waiting in the `settings` table (`setup_code`, written as `code|expiry-in-ms` through the
Cloudflare account) and is sent as `X-Setup-Code`. The code is used up by the first call
that stores something. A Worker secret named `ADMIN_KEY`, `RESEND_API_KEY` or
`ANTHROPIC_API_KEY` is used instead of the stored copy if one exists. Deploying keeps
existing Worker secrets.

Everything else is a plain setting in `wrangler.toml`: the rate, the close hour and time
zone, the daily limit, the sites allowed to call the service, the model, and who email
comes from.

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

For local runs put `VAULT_KEY=anything` and `ADMIN_KEY=anything` in `.dev.vars` (ignored
by git) and start with `npx wrangler dev --var OPEN:true`.

Deploying needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment.
New tables or columns go in a new file under `migrations/`, applied with
`npm run migrate:remote`.

Email addresses are not verified. Anyone can bid under any address, and a bid only
becomes real when the winner pays. A winner who does not pay is passed over in `/admin`.

## The AI screen

One Claude call per bid, using the model in `SCREEN_MODEL`. The call asks for a fixed
JSON shape and low effort. If the model declines, errors or times out, the bid is held
for a person; it is never allowed by default. The call has not been run against the real
API yet: it was tested against a local stand-in that returns the same response shape.
