# Development

Requires Node 24.21+ and Bun 1.3.14+. The commands are the same on Linux, macOS, and Windows.

```sh
git clone https://github.com/Skare69/velvarr.git && cd velvarr
bun install
bun run setup   # writes .env.local with fresh secrets; never overwrites it
bun run dev     # http://127.0.0.1:6699
```

Checks before a commit:

```sh
bun run format && bun run check && bun run test && bun run build
```

[`docs/how-it-works.md`](how-it-works.md) explains how the code is
put together: the architecture map, the request-to-playback flow, and
the acquisition life cycle, each tied to its source paths.

[Testing](testing.md) covers the unit/API suite and production-build settings browser regressions.

[`scripts/screenshots/README.md`](../scripts/screenshots/README.md) explains how to
make the landing-page screenshots in `site/shots/` again from the
current app (`bun run shots`).
