# The Stag Knows

A lightweight, serverless moderation and publishing workflow for the University of Surrey confessions page. The app receives Tally submissions, renders confession artwork through Cloudinary, queues moderation in Discord, and publishes approved content to Instagram.

## Request flow

1. **Tally submission → `api/post.js`**
   - Accepts POST only and verifies the Tally HMAC-SHA256 signature with `TALLY_WEBHOOK_SECRET`.
   - Reads the confession text from the first Tally field, builds a Cloudinary image URL, and stores `{ text, imageUrl }` in Redis as `conf_<uuid>` for 24 hours.
   - Sends a yellow Discord embed containing the text and image, with Stage, Post Now, and Delete buttons. The moderator mention remains outside the embed so Discord can notify the moderator.

2. **Discord interaction → `api/interactions.js`**
   - Reads the raw request body and verifies Discord's Ed25519 signature with `DISCORD_PUBLIC_KEY`.
   - Handles the `/staged` command, moderation buttons, staged-queue controls, and caption modals.
   - Uses `waitUntil()` for work that continues after Discord receives its acknowledgement.

3. **Moderation and queue**
   - Stage adds a serialized confession to the Redis list `staged_posts`, up to 10 entries, then removes the temporary `conf_<uuid>` record. The Discord source embed turns blue and its controls are removed.
   - `/staged` displays and manages queue order. Unstaging recreates a temporary record and restores the original Discord moderation message and buttons.
   - If a temporary record expires, moderation can recover text and image URL from the source embed. The older content-plus-image format remains supported during migration.

4. **Publishing → `lib/instagram.js`**
   - Post Now publishes one confession; staged publishing can publish a carousel.
   - Redis locks prevent overlapping publish operations. Post Now has a 24-hour duplicate guard. Staged publishing records a fingerprint before queue cleanup so a retry can finish cleanup without republishing.

5. **Archive**
   - A successful post is copied to the Discord channel in `DISCORD_ARCHIVE_ID` with a green embed. A deleted confession is copied with a red embed.
   - The archive copy is created before the source message is removed. If archive creation fails, a deleted confession remains recoverable and can be retried; a published confession is marked green as archive-pending and gets a Retry Archive button.
   - Staged records stay in Redis only when an older queue item has no source Discord message and its archive copy fails. For current items, an archive failure leaves a Retry Archive button on the source and clears the published queue. The saved publish fingerprint prevents cleanup retries from repeating Instagram publication.
   - `discord_archived_<uuid>` stores only the Discord archive message ID for seven days to prevent duplicate archive copies. The confession itself is not retained in Redis after successful archival/deletion cleanup.

## Runtime and storage

- Vercel serverless functions are the application runtime; there is no separate web frontend or persistent server.
- `api/post.js` and `api/interactions.js` are the external HTTP entry points.
- `lib/cloudinary.js` wraps confession text to fit a 1080×1080 image template. `CLOUDINARY_RENDERING.md` documents the rendering geometry.
- `lib/redis.js` shares an ioredis client across reused serverless instances and reads `REDIS_URL`.
- `lib/instagram.js` implements Instagram media creation, status polling, and publication through the Graph API.
- Dependencies are declared in `package.json`. This deliberately lightweight repository currently has no lockfile or GitHub Actions workflow.

## Environment variables

Set secrets in Vercel; do not commit values. The production deployment requires:

| Variable | Used by |
| --- | --- |
| `TALLY_WEBHOOK_SECRET` | HMAC validation for Tally submissions |
| `REDIS_URL` | Temporary confession records, staged queue, locks, and publish/archive guards |
| `DISCORD_PUBLIC_KEY` | Discord interaction signature validation |
| `DISCORD_APP_ID` | Discord interaction responses and follow-ups |
| `DISCORD_BOT_TOKEN` | Moderation and archive channel messages |
| `DISCORD_CHANNEL_ID` | New confession moderation channel |
| `DISCORD_ARCHIVE_ID` | Reference channel for posted and deleted confessions |
| `INSTAGRAM_ACCOUNT_ID` | Instagram Graph API publishing |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram Graph API publishing |

Optional Cloudinary overrides read by code: `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_BACKGROUND_PUBLIC_ID`. Defaults are `hff7fini` and `background_v3`. The Vercel project also contains `CLOUDINARY_CLOUD_NAM` (without the final E); the code does not read that misspelled name, but the default currently keeps rendering functional.

The connected Vercel project has `DISCORD_ARCHIVE_ID` and `TALLY_WEBHOOK_SECRET` configured for Production. Preview deployments do not have the production Redis URL or these production secrets, so do not expect submission, moderation, or archiving flows to work on Preview without a separate safe test configuration.

## Discord setup

- Set the Discord Interactions Endpoint URL to the deployed `/api/interactions` route and keep the matching application public key in Vercel.
- Register the `/staged` slash command in the Discord application.
- The bot needs View Channel, Send Messages, and Embed Links in both channels. It removes only the moderation messages it authored.
- Tally must send its signed webhook to `/api/post`; its signing secret must match `TALLY_WEBHOOK_SECRET`.

## Deploy and maintain

Changes pushed to the GitHub default branch deploy through the linked Vercel project. Use a branch/preview for review, then merge to deploy production. Do not test with real Tally submissions against production unless an actual confession should enter the moderation workflow.

When changing Redis records or Discord embed structure, keep reads backward-compatible until older queue entries and moderation messages have expired or been handled. Never log environment variable values or confession text unless a specific debugging need justifies it.
