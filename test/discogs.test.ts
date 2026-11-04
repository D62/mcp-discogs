import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DiscogsClient, type FetchLike } from "../src/client.js";
import { buildServer, loadConfig, summarizeRelease, type Config } from "../src/index.js";

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const release = {
  id: 249504,
  title: "Discovery",
  artists: [{ name: "Daft Punk" }],
  year: 2001,
  country: "Europe",
  labels: [{ name: "Virgin", catno: "7243 8 49620 1 0" }],
  formats: [{ name: "Vinyl", descriptions: ["LP", "Album"] }],
  identifiers: [{ type: "Barcode", value: "724349620107" }],
  uri: "https://www.discogs.com/release/249504",
};

function setup(opts: { allowWrites: boolean; fetchImpl: FetchLike; journal: string }) {
  const cfg: Config = { token: "T", username: "testuser", allowWrites: opts.allowWrites, journalPath: opts.journal };
  const client = new DiscogsClient({ token: "T", fetchImpl: opts.fetchImpl, minIntervalMs: 0 });
  return { cfg, server: buildServer(client, cfg) };
}

async function connect(server: ReturnType<typeof buildServer>) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const textOf = (r: any) => (r.content as { text: string }[])[0].text;

test("summarizeRelease keeps identifying fields", () => {
  const s = summarizeRelease(release);
  assert.deepEqual(s.artists, ["Daft Punk"]);
  assert.deepEqual(s.barcodes, ["724349620107"]);
  assert.equal(s.labels[0], "Virgin 7243 8 49620 1 0");
});

test("client sends token and User-Agent headers", async () => {
  let headers: Record<string, string> = {};
  const c = new DiscogsClient({
    token: "SECRET",
    minIntervalMs: 0,
    fetchImpl: async (_u, init) => {
      headers = init?.headers as Record<string, string>;
      return json(release);
    },
  });
  await c.get("/releases/1");
  assert.equal(headers.Authorization, "Discogs token=SECRET");
  assert.match(headers["User-Agent"], /discogs-mcp/);
});

test("read-only mode does NOT register the write tool", async () => {
  const { server } = setup({ allowWrites: false, fetchImpl: async () => json({}), journal: "/dev/null" });
  const client = await connect(server);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "discogs_get_collection",
    "discogs_get_release",
    "discogs_list_folders",
    "discogs_search_releases",
  ]);
  await client.close();
});

test("search requires a filter and maps results", async () => {
  let url = "";
  const { server } = setup({
    allowWrites: false,
    journal: "/dev/null",
    fetchImpl: async (u) => {
      url = u;
      return json({ pagination: { items: 1 }, results: [{ id: 249504, title: "Daft Punk - Discovery", year: "2001", format: ["Vinyl"], label: ["Virgin"], catno: "7243" }] });
    },
  });
  const client = await connect(server);
  const empty = await client.callTool({ name: "discogs_search_releases", arguments: {} });
  assert.equal(empty.isError, true);

  const r = await client.callTool({ name: "discogs_search_releases", arguments: { barcode: "724349620107" } });
  assert.match(url, /barcode=724349620107/);
  assert.match(url, /type=release/);
  assert.match(textOf(r), /"id": 249504/);
  await client.close();
});

test("collection read uses the configured username", async () => {
  let url = "";
  const { server } = setup({
    allowWrites: false,
    journal: "/dev/null",
    fetchImpl: async (u) => {
      url = u;
      return json({ releases: [] });
    },
  });
  const client = await connect(server);
  await client.callTool({ name: "discogs_get_collection", arguments: { folder_id: 1 } });
  assert.match(url, /\/users\/testuser\/collection\/folders\/1\/releases/);
  await client.close();
});

test("write tool: dry_run is the default and writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discogs-test-"));
  const journal = join(dir, "journal.jsonl");
  const calls: string[] = [];
  const { server } = setup({
    allowWrites: true,
    journal,
    fetchImpl: async (u, init) => {
      calls.push(`${init?.method} ${u}`);
      return json(release);
    },
  });
  const client = await connect(server);
  const r = await client.callTool({ name: "discogs_add_to_collection", arguments: { release_id: 249504 } });
  const body = JSON.parse(textOf(r));
  assert.equal(body.dry_run, true);
  assert.equal(body.wouldAdd.title, "Discovery");
  assert.ok(calls.every((c) => c.startsWith("GET")), "no POST on dry run");
  assert.equal(existsSync(journal), false);
  await client.close();
});

test("write tool: real add posts to the folder and is journaled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discogs-test-"));
  const journal = join(dir, "journal.jsonl");
  const calls: string[] = [];
  const { server } = setup({
    allowWrites: true,
    journal,
    fetchImpl: async (u, init) => {
      calls.push(`${init?.method} ${u}`);
      if (init?.method === "POST") return json({ instance_id: 987 }, 201);
      return json(release);
    },
  });
  const client = await connect(server);
  const r = await client.callTool({
    name: "discogs_add_to_collection",
    arguments: { release_id: 249504, folder_id: 1, dry_run: false },
  });
  const body = JSON.parse(textOf(r));
  assert.equal(body.added.instanceId, 987);
  assert.ok(calls.includes("POST https://api.discogs.com/users/testuser/collection/folders/1/releases/249504"));
  const lines = readFileSync(journal, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).releaseId, 249504);
  await client.close();
});

test("loadConfig: writes are off unless explicitly enabled", () => {
  assert.equal(loadConfig({ DISCOGS_TOKEN: "x" }).allowWrites, false);
  assert.equal(loadConfig({ DISCOGS_TOKEN: "x", DISCOGS_ALLOW_WRITES: "true" }).allowWrites, true);
  assert.equal(loadConfig({ DISCOGS_TOKEN: "x", DISCOGS_ALLOW_WRITES: "no" }).allowWrites, false);
});
