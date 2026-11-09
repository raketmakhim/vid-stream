# vid-stream

Private watch-together page. See [PLAN.md](PLAN.md) for the design.

## Layout

| Path | What it is |
|---|---|
| `web/index.html` | Structure only: the elements on the page |
| `web/style.css` | All the design: colours, fonts, spacing, light/dark |
| `web/app.js` | All the behaviour: login, library, sync, subtitles |
| `lambda/` | Login and sync functions (AWS) |
| `terraform/` | The AWS infrastructure |
| `videos/` | Your videos, subtitles and `library.json` |
| `dev/` | Local preview server |

Terraform uploads every file in `web/`, so a new page file needs no extra setup.

## Deploy

```powershell
./deploy.ps1
```

It runs `terraform init` only if the folder hasn't been initialised, then `terraform apply`, which shows the plan and waits for you to type `yes` or `no`.

Terraform creates `/vidstream/password` with the placeholder `CHANGE_ME` (login is refused until you change it).
Set the real password in the AWS console: Systems Manager > Parameter Store > `/vidstream/password` > Edit.
Terraform never overwrites it afterwards.

## Add videos

Your videos, subtitles and `library.json` stay on your machine (they are git-ignored). Start from the example:

```powershell
Copy-Item videos/library.example.json videos/library.json
```

Put `film.mp4` and its subtitles (`film.en.vtt` or `film.en.srt`) in `videos/`, then edit `videos/library.json` to list them. Each entry has a `title`, a `video` file, and optionally `poster` (an image) and `subs`. See `videos/library.example.json`.

```powershell
./upload.ps1
```

`.srt` subtitles are converted to `.vtt` automatically before upload.

## Use

Open the `url` output (`terraform -chdir=terraform output url`), enter the password, pick a video. Share the URL and password with your friend.

## Preview locally

```powershell
node dev/server.js
```

Open http://localhost:8080. Any password works. It serves the page and your `videos/` folder and relays play/pause/seek between tabs, so you can try the sync with two tabs. Nothing touches AWS.

- `$env:DEMO = 1; node dev/server.js` adds a few extra titles so you can judge the library list.
- A `.srt` with no matching `.vtt` is converted on the fly.
- It does not test the AWS parts: the signed-cookie lock, API Gateway or the Lambdas.
- Optional: add `"poster": "film.jpg"` to a library entry (and put the image in `videos/`) for a small thumbnail beside its title.

## Test

```powershell
node --test lambda/lib.test.js dev/server.test.js
```
