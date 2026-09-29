# Abralo website

Standalone public product site for Abralo, built with static HTML, CSS, and a small Node server. The site is designed to deploy as a separate Railway service from the desktop application.

Typography is self-hosted from IBM Plex Sans and IBM Plex Mono under the included SIL Open Font License copies; the site makes no third-party font requests.

## Run locally

```sh
npm start
```

The server reads Railway's `PORT` variable and binds to `0.0.0.0`. `/health` is a lightweight health check.

## Railway

Set `/website` as the service root directory, `npm start` as the start command, and `/health` as the health-check path. Railway's current monorepo setup uses the service's root-directory setting; the older `railway.toml` format is deprecated. Attach `abralo.com` after the service is deployed and the DNS records are ready.

The public site does not yet link to downloads, a source repository, or a signup form. Add those only when the corresponding release destinations and processes are ready.
