# dgf-bids

The bid service behind daddygofaster.com. A Cloudflare Worker with a D1 database.
Live at `https://dgf-bids.trevor-c2b.workers.dev`.

The site's page (`../index.html`) calls two public endpoints. The owner uses `/admin`.

| Endpoint | Who | What |
|---|---|---|
| `GET /board` | anyone | Bids that passed the screen: name, amount, time. Never the job or the email. |
| `POST /bids` | anyone | Place a bid or raise one. Answers `qualified`, `short`, `held` or `refused` with a message. |
| `POST /bids/confirm` | the bidder's browser | Finishes a bid after the bidder's bank asked them to confirm the card. |
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
   - **short**: the estimated job exceeds the bid's time cap. The reply gives the
     bid needed for that time to be considered, or asks for a shorter job.
   - **qualified**: it goes on the board.
   Any winning bid includes up to 60 minutes. Each full $200 adds 60 minutes:
   $10 and $199 each cap at 60; $205 and $399 each cap at 120; $400 caps at 180.
   A longer job within the bid's cap is **held** until the owner explicitly approves
   the actual duration. The estimate never becomes a promise automatically.
4. A new high bid in the last five minutes moves the close back five minutes. There is
   no cap: while people keep outbidding each other, the round stays open.

**Raising a bid.** The same email sending the same job again raises that bid, and so
does the page sending the bid's private handle. The bid or its maximum has to go up, and
neither can come down. There is no new screen and no new row, it does not count against the daily
limit. The same time caps apply. A raise that makes a longer job eligible moves it to
owner review; it does not bypass approval or automatically extend an agreed duration.

Bidding for a job day closes at 8 p.m. Central the evening before, and the next round
opens straight away. A round that has run past its close is settled the next time anyone
loads the board, bids, or opens `/admin`, and by a timer that runs every minute. The
highest qualifying bid wins and the earlier bid wins a tie.

## Auto-bid

A bid can carry a hidden maximum. The bid then rises on its own, one cent over the next
bid, whenever someone outbids it, and stops at the maximum. Two maximums answer each
other at once: the higher one leads at one cent over the lower. If a bid starts below what
its job's time tier and its maximum reaches that amount, it goes up to exactly that
amount and waits for owner approval. For example, a 90-minute job can lift to $200
when the maximum permits it, but stays held until its actual time is agreed.
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
| `STRIPE_SECRET_KEY` | no | A Worker secret. Holds, charges and releases. Never sent to a browser. |
| `STRIPE_PUBLISHABLE_KEY` | no | A Worker secret. Handed to the site's page so it can show the card box. |

Card holds are on when both Stripe keys are set, and off when either is missing. Use the
test-mode pair first: with those, Stripe's test cards work and no real card can be held.

The admin, email and AI keys go in through `POST /admin/api/setup`, as the request headers
`X-Admin-Key`, `X-Mail-Key` and `X-Ai-Key`. The call only works while a one-time code is
waiting in the `settings` table (`setup_code`, written as `code|expiry-in-ms` through the
Cloudflare account) and is sent as `X-Setup-Code`. The code is used up by the first call
that stores something. A Worker secret named `ADMIN_KEY`, `RESEND_API_KEY` or
`ANTHROPIC_API_KEY` is used instead of the stored copy if one exists. Deploying keeps
existing Worker secrets.

The time policy is defined in `src/rules.js` (`TIME_POLICY`) and mirrored in the page's
readout and pricing table. The remaining settings are in `wrangler.toml`: the close hour and time
zone, the daily limit, the sites allowed to call the service, the model, and who email
comes from.

## Opening and closing bidding

`OPEN` in `wrangler.toml` is the master switch. While it is not `"true"` the board says
`soon`, bids are refused, and nothing is written to the database. Change it and deploy:

```sh
npm run deploy
```

## Payment: card holds

A bid needs a card. The bid is held on the card when it is placed, the winner's hold is
charged when the round closes, and every other hold is released. Card processing is
Stripe. This is on when both card keys are set (see Keys). With either missing, bids
need no card and the owner collects payment by hand, as before.

**What is held.** The most the bid could reach: its auto-bid maximum if it has one,
otherwise the bid. Cards cannot hold less than 50 cents, so a one-cent bid holds 50 cents.
A bid that is refused, or falls short of its job, holds nothing.

**The card never touches this service.** The site's page hands the card to Stripe and
sends back only Stripe's id for it. The database keeps Stripe's ids for the customer, the
card and each hold. No card number, expiry or security code is ever stored or logged.

**Raising.** A raise holds only the difference, on the card already on the bid, and only
when the raise goes past what is held. A one-cent raise holds 50 cents, which then covers
the next 49 cents of raises. After seven holds on one bid, the next raise takes one hold
for the whole amount and releases the others. The saved card is only used for the browser
that holds the bid's private handle; someone who only knows the email and the job has to
bring a card of their own.

**When the bank wants the cardholder to confirm (3-D Secure).** The bid waits in status
`card`, which nothing shows. The page runs the bank's check and calls `POST /bids/confirm`;
the service reads the result from Stripe itself. A check nobody finishes is released after
30 minutes.

**When the round closes.** The timer (or the owner pressing Close) charges the winner's
holds for the winning amount, not the maximum, and releases what is left. A last slice
under 50 cents is let go, and a winning bid under 50 cents is free. If the winner's card
fails, the win passes to the next bid while its hold is still there. Then every other
hold is released. Costs (the estimate beside the bid) are not charged: the owner collects
those.

**Passing over a winner.** "Pass to the next bid" in `/admin` refunds whatever the winner
was charged and charges the next bid's saved card. If that card fails, `/admin` says so
and the owner can pass again.

**Limits that stop card testing.** A declined card places no bid, but the try is kept and
counted: 20 tries per email per day, 30 per network address per hour, and 5 declined
tries per bid.

**What it costs.** Stripe charges its fee on each captured hold, not on released ones. A
bid raised several times is charged as several payments, each with its own fixed fee.

**What the owner can see.** `/admin` shows whether a card holds each bid, never the
amount, so a hidden maximum stays hidden there. The Stripe dashboard shows each hold's
amount.

This has been run against a local stand-in for Stripe, not against Stripe itself.

## The owner's page

`/admin` shows bids waiting for a person, every bid in the current round, and the last
winner. Jobs are hidden unless "Show the jobs" is ticked, so the owner can stay
surprised. Someone should still read the winning job before it is done.

Approval requires the owner to enter the time they agree to spend. The server rejects
durations above the current bid's cap, regardless of a hidden auto-bid maximum. A $210
bid can be approved for 120 minutes; a $199 bid cannot. The agreed time is shown in the
bidder's standing and owner view. Extra costs remain separate.

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

Email addresses are not verified. With card holds on, a bid is real because a card is
holding it. With them off, anyone can bid under any address, a bid only becomes real when
the winner pays, and a winner who does not pay is passed over in `/admin`.

## The AI screen

One Claude call per bid, using the model in `SCREEN_MODEL`. The call asks for a fixed
JSON shape and low effort. If the model declines, errors or times out, the bid is held
for a person; it is never allowed by default. The call has not been run against the real
API yet: it was tested against a local stand-in that returns the same response shape.
