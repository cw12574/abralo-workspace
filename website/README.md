# Abralo website

Standalone public product site for Abralo, built with static HTML, CSS, and a small Node server. The launch page is a separate Railway service from the desktop application.

Typography is self-hosted from IBM Plex Sans and IBM Plex Mono under the included SIL Open Font License copies; the site makes no third-party font requests.

## Run locally

```sh
npm start
```

The server reads Railway's `PORT` variable and binds to `0.0.0.0`. `/health` is a lightweight health check.

## Railway

The production domain `abralo.com` (and `www.abralo.com`) is attached to service `Service` (`2d368d7c-59cb-4887-9531-dd46be7cb79e`) in project `Abralo`, production environment. The similarly named `abralo-web` service does not own these domains. Deploy only this directory, using its Dockerfile and port 8080:

```sh
railway up ./website --path-as-root --project 411e6cdc-97ba-4f74-8f72-175697f6df9b --environment production --service 2d368d7c-59cb-4887-9531-dd46be7cb79e --detach
```

After deploying, verify Railway reports success and check `/health`, the homepage, mobile navigation, assets, and release links on both public domains. This service is uploaded via CLI; pushing the GitHub repository alone does not deploy the website. The preceding successful website deployment is `f1b03702-8bcc-400b-9b37-a3144d0b531e` (source commit `5428b0b`).

The page links to the public v0.1.3-preview release, `/start.html`, the source repository, and issue tracker. Keep download and guide links aligned when publishing later previews.

## Walkthrough provenance

The hero field note paraphrases a genuine review captured on 4 October 2026. The screenshots and recording show the real Abralo application in an isolated disposable workspace. The shop and its two project files are fictional; the two Codex responses are real, completed provider runs. No customer conversations, provider credentials, private prompts, or production workspace data are included.

`assets/demo/transcript.txt` contains the exact sample files, brief, responses, and operator decision. `responses.json` supplies the accessible transcript. The operator entered the final decision; the read-only agents did not fix the files. Both reviewers used Codex, so this is not evidence of a Claude/OpenCode run.

The 35-second MP4 was edited from a 46.92-second screen capture. Original seconds 10–39 run at 4× speed; the final frame is held for 10 seconds. English WebVTT captions disclose the shortened wait. No provider response was fabricated. The walkthrough itself is local static content, not an agent session running in the visitor's browser. It makes no provider calls and installs nothing. The video loads on demand.

## Verification

From the repository root, with the website running on port 4387:

```sh
node scripts/website-smoke.mjs http://127.0.0.1:4387
```

The same command accepts a deployed origin. It checks 320/390/768/1440px layouts, keyboard tabs, screenshot/video dialogs, video playback and seeking, captions, setup navigation, public-file restrictions and byte ranges. Inspect desktop and mobile captures visually too.

Human comprehension and first-install testing remain separate: show the page to five unfamiliar people, then observe two first tasks. Automated browser checks do not establish either result. No visitor analytics or outside outreach was added.
