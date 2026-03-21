# Jarvis Live Reviewer

Local app for running a Gemini-powered "who is ahead" scoring bar during a live coding competition.

## What it does

- Lets you paste the problem statement for the current round.
- Captures participant stream windows from a local browser tab using the Screen Capture API.
- Periodically sends screenshots to Gemini Vision and asks it who is currently ahead.
- Smooths score updates so the overlay does not thrash when someone is in the middle of typing.
- Publishes the current state over websockets so a remote OBS browser source can render the live bar.
- Lets you enable or disable scoring without closing the app.

## Recommended setup

1. Open each participant's Discord stream in its own pop-out window if possible.
2. Start this app locally.
3. Open `http://127.0.0.1:8787/control.html`.
4. Paste the problem statement, add or rename participants, and save.
5. Click `Connect Source` once for each participant card and choose the matching Discord stream window.
6. Set the analysis interval you want, then click `Enable Scoring`.
7. Use the overlay URL shown in the control page as the OBS browser source URL.

## Install

```bash
npm install
npm start
```

Optional environment variables:

```bash
PORT=8787
HOST=127.0.0.1
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.0-flash
CONTROL_TOKEN=optional_secret
```

If `GEMINI_API_KEY` is not set, you can also enter it in the control page. The key is kept in server memory for the current run.

## Cloudflare tunnel for remote OBS

Cloudflare Tunnel supports websockets, so the overlay page should continue receiving live updates through the same public URL.

Example:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Then give the remote OBS operator the public URL plus:

```text
/overlay.html?session=default
```

Keep the tunnel URL private, especially if you do not set `CONTROL_TOKEN`.

## Scoring behavior

- Blank editors or pure boilerplate should remain even.
- Incomplete code gets partial credit when it shows the right approach.
- Temporary syntax errors should not swing the bar too hard.
- If some captures are missing, the app falls back to an even score until everyone has a screenshot.

The server asks Gemini for an absolute progress estimate from `0-100`, then smooths that score and converts it into an OBS-friendly bar percentage.

## Notes

- Modern browsers require a user gesture for each screen/window capture prompt.
- This project assumes the operator runs the control page locally in a Chromium-based browser.
- If you want stricter access control for the control API, set `CONTROL_TOKEN` and send it in `x-control-token` from your own tooling or a reverse proxy.


