// Thin client for the Discogs REST API (https://www.discogs.com/developers).

export const BASE_URL = "https://api.discogs.com";
export const USER_AGENT = "discogs-mcp/0.1 (personal use)";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DiscogsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "DiscogsError";
  }
}

export interface ClientOptions {
  token: string;
  fetchImpl?: FetchLike;
  /** Discogs allows 60 req/min when authenticated. */
  minIntervalMs?: number;
  baseUrl?: string;
}

export class DiscogsClient {
  private token: string;
  private fetchImpl: FetchLike;
  private minIntervalMs: number;
  private baseUrl: string;
  private lastCall = 0;

  constructor(opts: ClientOptions) {
    if (!opts.token) throw new Error("DISCOGS_TOKEN is required");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.minIntervalMs = opts.minIntervalMs ?? 1100;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCall + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
  }

  private async request(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | undefined> = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${this.baseUrl}${path}${qs.toString() ? `?${qs}` : ""}`;

    await this.throttle();
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Discogs token=${this.token}`,
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (res.status === 401 || res.status === 403)
      throw new DiscogsError(res.status, "Discogs rejected the token (check DISCOGS_TOKEN and its permissions).");
    if (res.status === 404) throw new DiscogsError(404, "Not found on Discogs.");
    if (res.status === 429) throw new DiscogsError(429, "Discogs rate limit reached, retry in a minute.");
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new DiscogsError(res.status, `Discogs returned HTTP ${res.status}. ${body.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined;
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  get<T = any>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    return this.request("GET", path, params) as Promise<T>;
  }

  post<T = any>(path: string): Promise<T> {
    return this.request("POST", path) as Promise<T>;
  }
}
