# pc5-bot

Telegram key shop + admin panel. All state is committed to a private repo so
restarts and redeploys are lossless.

## Repo sync

1. Create a **private** repo, e.g. `youruser/pc5-data`.
2. Fine-grained PAT → that repo only → `Contents: Read and write`.
3. Put it in `GITHUB_TOKEN`, plus `GITHUB_REPO=youruser/pc5-data`.
4. Deploy. On boot the bot pulls `data/state.json` and refuses to start writing
   until it has either restored it or created it.

Every mutation commits within ~4s. A heartbeat retries unsaved changes every
10 minutes and SIGTERM flushes before exit.

## Render

- Build: `npm install`
- Start: `node app.js`
- Env: `BOT_TOKEN`, `ADMIN_IDS`, `PANEL_PASSWORD`, `GITHUB_TOKEN`, `GITHUB_REPO`,
  `UPI_ID`, `UPI_NAME`, `GITHUB_PATH=data/state.json`
- Free instances spin down after 15 min idle and the bot stops. Point a cron
  (cron-job.org or a GitHub Actions schedule) at `https://<app>.onrender.com/panel`
  every 10 minutes to keep it warm.
