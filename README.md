# mcp-discogs

Local MCP server (stdio) for the Discogs API.

## Install (run the server)

Tested with Node.js v26. Other versions are not checked yet.

```
npm ci --omit=dev
```

`dist/` is committed, so there is no build step. Run the server with:

```
DISCOGS_TOKEN=your-token DISCOGS_USERNAME=your-username node dist/index.js
```

Environment variables:

- `DISCOGS_TOKEN` (required): personal access token. Create one at https://www.discogs.com/settings/developers.
- `DISCOGS_USERNAME`: your Discogs username. Needed for the collection tools.
- `DISCOGS_ALLOW_WRITES=true`: only then is the write tool registered. Off by default.
- `DISCOGS_JOURNAL`: path of the write journal (default `journal.jsonl`).

To use it from an MCP client, point the client at `node /absolute/path/to/mcp-discogs/dist/index.js` and pass these variables in its `env`. Never commit the token.

## Tools

Read (always on):

- `discogs_search_releases`: search by barcode, catalogue number, artist, or title.
- `discogs_get_release`: release details.
- `discogs_list_folders`: collection folders.
- `discogs_get_collection`: releases in a folder.

Write (only with `DISCOGS_ALLOW_WRITES=true`):

- `discogs_add_to_collection`: adds a release to a collection folder. `dry_run` defaults to `true` and only previews the release. A real add needs `dry_run=false` and is appended to the journal.

## Capabilities and limits

- **Reads work against the live API.** Checked with a personal token: release search by artist and title, folder list, and collection read.
- **Barcode search can return 0 results** for releases that exist. This means the database has no matching entry, not that the server is broken.
- **The write tool is not yet tested live.** The mocked tests pass. Before a real add, check that the token can write to the collection, using `dry_run` first.
- **Collection tools need `DISCOGS_USERNAME`.** Without it they return an error.
- **The server only adds releases.** It does not edit or delete collection items.

## Development

Source is in `src/` (TypeScript). `dist/` is the compiled output, and it is committed.

```
npm ci              # all dependencies, including TypeScript
npm run build       # compile src/ to dist/
npm test            # unit tests, mocked HTTP
```

Before every commit that changes `src/`:

1. `npm run build`
2. `npm test`
3. commit `src/`, `test/` and `dist/` together.

If `dist/` is out of date, the server runs old code.

## Status

- Unit tests pass with mocked HTTP (8 tests).
- Live reads checked (see above). Live write not checked.
