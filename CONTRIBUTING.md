# Contributing to Velvarr

Thank you for your help. This guide tells you how to set up Velvarr, run the checks, and open a pull request. All participants must obey the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node 24.21 or later and Bun 1.3.14 or later. The commands are the same on Linux, macOS, and Windows.

```sh
git clone https://github.com/Skare69/velvarr.git && cd velvarr
bun install --frozen-lockfile
bun run setup   # writes .env.local with fresh secrets; never overwrites it
bun run dev     # http://127.0.0.1:6699
```

[docs/development.md](docs/development.md) has more about the development setup. [docs/how-it-works.md](docs/how-it-works.md) explains the architecture.

## Run the checks

Run these commands before each commit. Each command must exit with code 0.

```sh
bun run format
bun run check
bun run test
bun run build
```

CI also runs `bun run format:check`, `bun audit`, and the settings browser tests (`bun run test:ui`). [docs/testing.md](docs/testing.md) tells you how to run the browser tests.

## Open a pull request

1. Make a branch from `main`.
2. Keep each pull request on one subject.
3. Add or change tests for the behavior that you change.
4. When you change behavior that users see, update the docs.
5. Open the pull request, and fill in the template.

For a large change, open an issue first. Then we can agree on the approach before you write the code.

## AI-assisted contributions

You can use AI tools, as the maintainer does (see [How Velvarr is built](README.md#how-velvarr-is-built)). Say so in the pull request. Describe what the change does and how you checked that it works. Your pull request runs the same CI checks as the maintainer's changes, and an agent reviews it before the merge.

## Report a bug or ask for a feature

Use the [issue forms](https://github.com/Skare69/velvarr/issues/new/choose). For a security problem, read [SECURITY.md](SECURITY.md) and do not open a public issue. For an accessibility barrier, read [ACCESSIBILITY.md](ACCESSIBILITY.md).
