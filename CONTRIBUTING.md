# Contributing to WebDAVrSync

Thanks for taking the time to contribute! Issues and pull requests are both
welcome.

## Reporting a bug

Before opening an issue, please:

1. Search the [existing issues](https://github.com/xztjhs/WebDAVrSync/issues) —
   it may already be reported.
2. Make sure you are on the latest release.

When you open an issue, include:

- Obsidian version, and the plugin version shown in **Settings → Community plugins**.
- Operating system.
- The WebDAV server you use (Nextcloud, SFTPGo, ownCloud, nginx-dav, …) and its version.
- Steps to reproduce, what you expected, and what happened instead.
- Any `[WebDAVrSync]` lines from the developer console
  (`Ctrl+Shift+I` → Console). Please redact server addresses, usernames and
  passwords before pasting.

## Development

The plugin is plain CommonJS JavaScript. There is no build step — `main.js` is
the artifact.

```bash
git clone https://github.com/xztjhs/WebDAVrSync.git
# copy or symlink the repository into <vault>/.obsidian/plugins/webdavrsync/
```

Then restart Obsidian, or run **Reload app without saving** from the command
palette, and enable **WebDAVrSync** in Settings → Community plugins.

## Tests

Tests use [Bun](https://bun.sh):

```bash
bun test tests/sync.test.js
```

The suite starts an in-memory WebDAV server and a fake Obsidian `DataAdapter`,
then exercises the real `WebDAVClient` and `SyncEngine` from `main.js`. It covers
upload, download, conflicts, deletion propagation, ignore rules, non-ASCII paths,
the append-only trash archive, config export/import, and the encrypted
backup/restore flow.

Please add or update a test for any behaviour change, and make sure the whole
suite passes before opening a pull request.

## Pull requests

- Keep each pull request focused on one topic.
- Match the style of the surrounding code: plain ES2019 JavaScript, two-space
  indentation, no third-party dependencies, no build tooling.
- Bump `version` in `manifest.json` and `versions.json`, and update
  `CHANGELOG.md`, only when preparing a release.
- Never commit `data.json` — it holds the WebDAV password. It is already listed
  in `.gitignore`; keep it that way.
- Do not add code that sends data anywhere other than the WebDAV server the user
  configured.

## Release checklist (maintainers)

1. Bump `version` in `manifest.json` and add the same version to `versions.json`.
2. Update `CHANGELOG.md`.
3. Commit, then create a tag **equal to the version, without a `v` prefix**
   (for example `1.2.2`) and push it.
4. Create a GitHub release from that tag and attach `main.js` and
   `manifest.json` as individual release assets.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
