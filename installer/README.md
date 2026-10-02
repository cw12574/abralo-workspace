# Abralo installer command

Install the preview with pnpm or npm:

```sh
pnpm dlx abralo@preview
```

```sh
npm exec --yes --package=abralo@preview -- abralo
```

This command downloads the release that matches its own version, verifies the archive against the SHA-256 value pinned from that release's manifest, and runs the existing platform installer. It supports Windows x64, macOS x64/arm64, and Linux x64. Node.js 18 or newer plus pnpm/npm is required to run the command; Windows 10+, macOS, and Linux also need `tar`. The installed app uses its bundled Node runtime.

The GitHub Release includes a `SHA256SUMS` file, and the installer package pins those hashes independently. This detects changed or incomplete downloads; it does not establish the app publisher's identity. The Windows and macOS preview packages remain unsigned and can still show operating-system warnings. Review the [friends preview guide](https://github.com/cw12574/abralo-workspace/blob/main/docs/preview/START-HERE.md) before installing.

## Maintainer release steps

The GitHub Actions workflow builds all four packages when a `v*` tag is pushed. It creates a GitHub pre-release for version tags containing a hyphen, with one `.tar.gz` asset per platform and a `SHA256SUMS` file. All build, audit, test, and installer checks must pass before publication.

To publish the matching npm command, log in to npm and run these commands from this directory after the GitHub release succeeds:

```sh
npm login
npm publish --tag preview
```

The package version must match the GitHub release tag without its leading `v`. After the release succeeds, copy each platform archive's hash from its `SHA256SUMS` asset into the matching version entry in `releases.json`. The npm installer pins those hashes, so a changed GitHub asset will be rejected after the package is published. An npm version is permanent; verify the version, package contents, release assets, and hashes before publishing. The package name is `abralo`; npm must still confirm it is available at publication time.
