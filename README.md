# Advin Stock

Discord stock monitoring with restock alerts and paginated inventory summaries.

The stock tracker shows the full summary under combined `Category · Location` headings.
Each heading is followed by bold linked plan names and prices
in the form **KVM Standard 1** · $8.00. The summary has no tabs or buttons;
large inventories continue in additional messages only when Discord limits require it.
`/stock` opens a private table with category and page navigation. `!stock` posts a
button to open that private table. Each user browses independently.

## Run with Docker

Copy `.env.example` to `.env`, set `DISCORD_TOKEN` and `STOCK_ALERT_CHANNEL_ID`, then run:

```sh
docker compose up -d --build
docker compose logs -f bot
```

The bot runs as the `node` user (UID/GID 1000). Before startup, `stock-data-init`
sets ownership of the named data volume so volumes created by older root-based
containers remain writable. This preserves existing snapshots and sticky-message
state. The initializer has no network access or bot credentials.

To apply an update, run `docker compose up -d --build` again. Keep the named data
volume when updating; it stores the baseline used to detect restocks.

## Local development

Use Node.js 24.22.1 or a newer Node.js 24 release (matching `package.json` and Docker):

```sh
npm ci
npm run dev
```

For a production process, run `npm run build` followed by `npm start`.
Run `npm run check` for formatting, ESLint, TypeScript, and regression checks.
Use `npm run format` to apply formatting, `npm test` for regression tests, or
`npm run typecheck` for TypeScript alone. CI runs the full checks and a Docker build.
The development compiler uses TypeScript 6.0 because the installed TypeScript ESLint
rules do not yet support TypeScript 7.

## Configuration

| Variable                 | Default                      | Purpose                                       |
| ------------------------ | ---------------------------- | --------------------------------------------- |
| `DISCORD_TOKEN`          | Required                     | Discord bot token                             |
| `STOCK_ALERT_CHANNEL_ID` | None                         | Enables polling and selects the alert channel |
| `STOCK_JSON_URL`         | Advin public stock API       | Stock feed                                    |
| `STOCK_POLL_INTERVAL_MS` | `300000`                     | Delay after a completed poll; minimum `10000` |
| `STOCK_SNAPSHOT_PATH`    | `./data/stock-snapshot.json` | Persisted stock baseline                      |

The sticky-message state is stored alongside the snapshot. The bot needs the
Message Content intent enabled in Discord and permission to view the channel,
send messages, embed links, and read message history.

The first successful poll creates a baseline without posting historical restocks.
Subsequent alerts report transitions from zero stock to available stock. Failed
deliveries retain the previous baseline for retry. If Discord accepts a message
before a later send or snapshot write fails, a retry may duplicate that alert.
Snapshots and sticky state use atomic file replacement. SIGINT and SIGTERM cancel
polling and drain pending work, with a 15-second shutdown deadline.

Order links use each plan's billing product ID and affiliate ID `109`.

## Code organization

`src/lib/stockData.ts` normalizes API data, validates saved snapshots, and compares
inventory independently of feed ordering. The monitor owns the committed alert
baseline; the sticky manager owns the latest observed inventory and invalidates
cached views only when that inventory changes. Rendering and formatting helpers
are separate from polling and Discord mutations.

Unchanged polls skip snapshot writes and summary edits. Each poll still checks
tracked messages against Discord so deleted summaries are recreated. Commands
and navigation reuse cached private pages; channel activity and successful
restock alerts still move the summary to the bottom. Summary timestamps change
when their content is updated rather than on every poll.

Monitor tests inject a fetch function and a separate sticky manager. Keep tests
independent of live Discord credentials and the public stock endpoint.

The `minimatch` override selects the patched 11.x release for development tooling
that still requests affected older versions. Remove it when the lint dependencies
adopt the patched release themselves; lint and typecheck cover its current usage.
