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

After deploying, verify Railway reports success and check `/health`, the homepage, mobile navigation, assets, and release links on both public domains. This service is uploaded via CLI; pushing the GitHub repository alone does not deploy the website. The pre-launch deployment available for rollback is `114599c5-9eb3-4094-8442-5e2055e184d9`.

The page links to the public v0.1.3-preview release, its versioned setup guide, source repository, and issue tracker. It does not collect email addresses. The product UI shown on the page is an illustrative concept, not a live app embed. Keep the release and guide links aligned when publishing later previews.
