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

Use Node.js 22.12 or later:

```sh
npm ci
npm run dev
```

For a production process, run `npm run build` followed by `npm start`.
Use `npm test` for regression checks and `npm run typecheck` for TypeScript checks.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | Required | Discord bot token |
| `STOCK_ALERT_CHANNEL_ID` | None | Enables polling and selects the alert channel |
| `STOCK_JSON_URL` | Advin public stock API | Stock feed |
| `STOCK_POLL_INTERVAL_MS` | `300000` | Delay after a completed poll; minimum `10000` |
| `STOCK_SNAPSHOT_PATH` | `./data/stock-snapshot.json` | Persisted stock baseline |

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
