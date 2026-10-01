# Contributing

Thanks for taking an interest in Abralo. The project is an early preview, so please check open issues before starting a large change.

## Report a bug

Use GitHub Issues for ordinary bugs and suggestions. Include the app version or commit, operating system and CPU, short reproduction steps, expected behavior, and what happened. Use disposable data. Do not attach a workspace database, provider session files, secrets, full conversations, or unreviewed logs. For a suspected security issue, follow [the security policy](SECURITY.md) instead of opening a public issue.

## Propose a change

For a substantial change, open an issue first so its scope can be discussed. Keep pull requests focused and describe user-visible effects, risks, and manual checks. Do not include generated release artifacts, local evidence, credentials, or personal data.

## Run checks

Use Node.js 24.16.x and pnpm 10.33.4. From a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Some scripts make real provider calls and use the signed-in account's allowance. Do not run them unless the account owner has explicitly agreed. CI builds platform packages on hosted runners.

By contributing, you agree that your contribution is offered under the repository's Apache-2.0 license.
