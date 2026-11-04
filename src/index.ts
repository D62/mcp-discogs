#!/usr/bin/env node
// Discogs MCP server.
// Read tools are always available. The single write tool (add to collection)
// is registered ONLY when DISCOGS_ALLOW_WRITES=true, and even then defaults to
// dry_run=true, so an agent has to ask explicitly for a real change.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DiscogsClient } from "./client.js";

export interface Config {
  token: string;
  username?: string;
  allowWrites: boolean;
  journalPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    token: env.DISCOGS_TOKEN ?? "",
    username: env.DISCOGS_USERNAME || undefined,
    allowWrites: /^(1|true|yes)$/i.test(env.DISCOGS_ALLOW_WRITES ?? ""),
    journalPath: env.DISCOGS_JOURNAL || join(here, "..", "journal.jsonl"),
  };
}

// Compact release view: what the agent needs to identify a pressing.
export function summarizeRelease(r: any) {
  return {
    id: r.id,
    title: r.title,
    artists: (r.artists ?? []).map((a: any) => a.name),
    year: r.year,
    country: r.country,
    labels: (r.labels ?? []).map((l: any) => `${l.name} ${l.catno ?? ""}`.trim()),
    formats: (r.formats ?? []).map((f: any) => [f.name, ...(f.descriptions ?? [])].join(", ")),
    barcodes: (r.identifiers ?? []).filter((i: any) => i.type === "Barcode").map((i: any) => i.value),
    masterId: r.master_id || undefined,
    url: r.uri,
  };
}

export function buildServer(client: DiscogsClient, cfg: Config): McpServer {
  const server = new McpServer({ name: "discogs", version: "0.1.0" });

  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const fail = (err: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  });
  const run = async <T>(fn: () => Promise<T>) => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err);
    }
  };
  const requireUser = (): string => {
    if (!cfg.username) throw new Error("DISCOGS_USERNAME is not set; collection tools need it.");
    return cfg.username;
  };

  server.registerTool(
    "discogs_search_releases",
    {
      title: "Search releases",
      description:
        "Search the Discogs database for releases. Use barcode or catno for the most precise match; otherwise artist + title. Returns candidate pressings to confirm with the user.",
      inputSchema: {
        query: z.string().optional(),
        artist: z.string().optional(),
        title: z.string().optional(),
        barcode: z.string().optional(),
        catno: z.string().optional(),
        label: z.string().optional(),
        format: z.string().optional().describe("e.g. Vinyl, CD, Cassette"),
        country: z.string().optional(),
        year: z.string().optional(),
        page: z.number().int().min(1).optional(),
      },
    },
    (args) =>
      run(async () => {
        const { query, artist, title, barcode, catno, label, format, country, year, page } = args;
        if (![query, artist, title, barcode, catno, label].some(Boolean))
          throw new Error("Give at least one of: query, artist, title, barcode, catno, label.");
        const r = await client.get("/database/search", {
          q: query,
          type: "release",
          artist,
          release_title: title,
          barcode,
          catno,
          label,
          format,
          country,
          year,
          page,
          per_page: 10,
        });
        return {
          pagination: r.pagination,
          results: (r.results ?? []).map((x: any) => ({
            id: x.id,
            title: x.title,
            year: x.year,
            country: x.country,
            format: (x.format ?? []).join(", "),
            label: (x.label ?? []).join(", "),
            catno: x.catno,
            thumb: x.thumb,
            masterId: x.master_id || undefined,
          })),
        };
      }),
  );

  server.registerTool(
    "discogs_get_release",
    {
      title: "Get release",
      description: "Get full details of one release by its Discogs id (tracklist, pressing, identifiers).",
      inputSchema: { release_id: z.number().int().positive() },
    },
    ({ release_id }) => run(async () => summarizeRelease(await client.get(`/releases/${release_id}`))),
  );

  server.registerTool(
    "discogs_list_folders",
    {
      title: "List collection folders",
      description: "List the folders of the configured Discogs user's collection, with their ids and item counts.",
      inputSchema: {},
    },
    () => run(async () => client.get(`/users/${requireUser()}/collection/folders`)),
  );

  server.registerTool(
    "discogs_get_collection",
    {
      title: "Get collection items",
      description: "List releases in a collection folder. folder_id 0 means all folders; 1 is Uncategorized.",
      inputSchema: {
        folder_id: z.number().int().min(0).default(0),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).default(50),
      },
    },
    ({ folder_id, page, per_page }) =>
      run(async () => {
        const r = await client.get(`/users/${requireUser()}/collection/folders/${folder_id}/releases`, { page, per_page });
        return {
          pagination: r.pagination,
          items: (r.releases ?? []).map((it: any) => ({
            instanceId: it.instance_id,
            folderId: it.folder_id,
            releaseId: it.id,
            title: it.basic_information?.title,
            artists: (it.basic_information?.artists ?? []).map((a: any) => a.name),
            year: it.basic_information?.year,
            formats: (it.basic_information?.formats ?? []).map((f: any) => f.name),
          })),
        };
      }),
  );

  if (cfg.allowWrites) {
    server.registerTool(
      "discogs_add_to_collection",
      {
        title: "Add release to collection",
        description:
          "WRITE: adds a release to the user's Discogs collection. Defaults to dry_run=true, which only shows the release that would be added. Call with dry_run=false ONLY after the user has explicitly confirmed this exact release_id. Every real add is logged to the journal.",
        inputSchema: {
          release_id: z.number().int().positive(),
          folder_id: z.number().int().min(1).default(1).describe("1 = Uncategorized"),
          dry_run: z.boolean().default(true),
        },
      },
      ({ release_id, folder_id, dry_run }) =>
        run(async () => {
          const user = requireUser();
          const release = summarizeRelease(await client.get(`/releases/${release_id}`));
          if (dry_run) return { dry_run: true, wouldAdd: release, folderId: folder_id, note: "Nothing written. Confirm with the user, then call again with dry_run=false." };

          const added = await client.post(`/users/${user}/collection/folders/${folder_id}/releases/${release_id}`);
          const entry = {
            ts: new Date().toISOString(),
            action: "add_to_collection",
            releaseId: release_id,
            folderId: folder_id,
            instanceId: added?.instance_id,
            title: release.title,
            artists: release.artists,
            year: release.year,
          };
          mkdirSync(dirname(cfg.journalPath), { recursive: true });
          appendFileSync(cfg.journalPath, JSON.stringify(entry) + "\n");
          return { dry_run: false, added: entry };
        }),
    );
  }

  return server;
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.token) {
    console.error("DISCOGS_TOKEN is not set");
    process.exit(1);
  }
  const server = buildServer(new DiscogsClient({ token: cfg.token }), cfg);
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
