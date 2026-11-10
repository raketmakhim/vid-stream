# Plan: private watch-together on AWS

**Goal:** two people open one password-protected page and watch the same video, with play, pause and seek synced.
**Content:** the owner's own videos only.
**Expected cost:** under ~$1/month at ~2 hrs/week (S3 storage is the only cost that grows).

## Architecture

```
Browser --> CloudFront --> S3 (private bucket: index.html + videos/)
   |            ^ signed cookie required for /videos/*
   |
   +- POST /login --> Lambda: check password -> set CloudFront signed cookies + return sync token
   +- WebSocket ----> API Gateway WS --> Lambda --> DynamoDB (connection ids)
```

Page, videos and `/login` are all served from the same CloudFront domain, so the signed cookies work without cross-domain problems.

## Pieces

1. **Storage and CDN.** Private S3 bucket reached through CloudFront with Origin Access Control. `/videos/*` requires a signed cookie (trusted key group). `index.html` and the login form are public and contain nothing sensitive.
2. **Login Lambda.** Compares the submitted password with one stored in SSM Parameter Store (SecureString). Returns CloudFront signed cookies plus a short-lived HMAC token for the WebSocket. Signing happens server-side only.
3. **Sync Lambda.** Handles `$connect` (rejects a bad token), `$disconnect`, and `message`. On `message`, reads all connection ids from DynamoDB and forwards the payload to everyone except the sender.
4. **Front-end.** Three files in `web/`: `index.html` (structure), `style.css` (design), `app.js` (behaviour). Password form and a `<video>` tag. Sends `{type: play|pause|seek, time}` on video events. Incoming messages are applied under an "applying remote" flag so they don't echo back.
5. **Infrastructure.** Terraform, one root module. AWS auth via whatever credentials the shell is already signed in with (no profile configured).

## Build order

1. Terraform: S3 bucket, CloudFront, OAC, key group. Upload a test video and check signed access works.
2. Login Lambda. Confirm `/videos/x.mp4` returns 403 without the cookie and plays with it.
3. WebSocket API, sync Lambda, DynamoDB. Test with two browser tabs.
4. Wire up `index.html`. Test from two real devices.
5. Add a $5 AWS Budget alert.

## Decisions

- One room only, no room ids.
- Videos uploaded manually with `aws s3 cp`. No upload UI.
- Plain MP4, H.264/AAC. No HLS or transcoding.
- Subtitles: separate WebVTT (`.vtt`) files next to each MP4 under `videos/`, loaded via `<track>` (protected by the same signed cookie). Convert with `ffmpeg -i in.srt out.vtt`. Each viewer picks their own subtitles; no syncing.
- Look: quiet and editorial rather than boxed. Serif titles, small spaced capitals for labels, hairlines instead of boxes or shadows, text links instead of bordered buttons, one soft gold accent. Login is just type on the page. The library is a numbered list of titles (optional `poster` thumbnail). Subtitle controls sit in an open "Subtitles" section. Dark by default, light follows the system setting.
- Chat: messages float on the video as plain outlined text, with no box, title or background; the same dark outline the subtitles use keeps them readable. A message shows for about 9 seconds (at most 6 at once, the oldest fading out at the edge) and lets clicks through to the video. Opening the chat (a speech-bubble icon on the video, or in the header) shows the whole history and a thin typing line; Enter sends, Escape closes. Icons at the bottom right of the video (chat, with an unread badge, and fullscreen) fade with the player's controls and reappear when a message arrives; the badge count is also in the tab title. The chat settings (name, text size, border, corner) live in the page's "Subtitles & chat" section with a live preview, so nothing on the video carries controls; they are saved per viewer. On a small video the stack sits above the control bar and leaves the icons uncovered. Fullscreen: the browser's own fullscreen shows only the video, so the page takes it over: a wrapper (video + icons + chat) goes fullscreen instead, via our button or a double-click on the video. The player's own fullscreen button is hidden in Chrome and Edge; Firefox and Safari still show it, and using it gives video-only fullscreen without chat. iPhone only allows the video itself in fullscreen. Chat reuses the sync WebSocket with a `chat` message (name up to 40 characters, text up to 500, checked by the relay in `lambda/lib.js`). Nothing is stored: messages exist only while the page is open. Chat works before a video is chosen (an empty stage with a hint).
- Local preview: `node dev/server.js` (no dependencies) serves the page and `videos/`, accepts any password and relays sync messages, so everything except the AWS pieces can be tried offline.
- Library: a hand-maintained `videos/library.json` (title, video file, list of subtitle tracks), behind the same signed cookie. The page shows a dropdown built from it. Picking a video is synced to the other viewer via a `{type: "load", video}` WebSocket message; subtitle choice is per viewer. Optional later: local `.vtt` file picker.
- Resume: each browser saves the last video and position per video in `localStorage` (every 5s and on pause/close) and reopens it paused at that spot. No server or DynamoDB needed. A connecting peer's position overrides it, so both land in the same place.
- Subtitle look: a "Subtitle settings" panel with a live preview and sliders for size, border (none to heavy) and position (sets each cue's `line`; an Auto tick-box leaves placement to the browser), colour presets plus a custom picker, and the ±0.5s timing buttons, per viewer, saved in `localStorage`. Applied by rewriting a `video::cue` style rule from the script.
- Subtitle timing: two buttons (-0.5s / +0.5s) shift every cue's `startTime`/`endTime` on the `TextTrack` in the browser (original times saved on first use). Offset is per viewer, saved in `localStorage` keyed by video name. No server work.
- No server-side playback state. A late joiner asks the other person to pause and play, or presses a "sync" button.
- One shared password, no user accounts.
- Lambda runtime: Node.js.

## Tests

- Two tabs: pause, play and seek in one, and the other follows with no echo loop.
- No cookie gives 403 on the video.
- A bad WebSocket token is rejected.
- Small self-check for the token sign/verify function.

## Risks / known limits

- The password check and signing key must stay in the Lambda and SSM. Never put them in front-end JS.
- `shortcut:` no rate limiting on `/login`. Add it if the URL is ever shared widely.
- The CloudFront signing private key lives in Terraform state. Keep state local or in a private encrypted bucket, and never commit it.
- Cookie expiry means re-login every N hours. Pick a sensible value (e.g. 12h).

## Open items

- Confirm the region (default `eu-west-2`).
- Pick the password.
