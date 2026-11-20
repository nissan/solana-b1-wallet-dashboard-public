// Server-side devnet JSON-RPC proxy. The Helius key stays on the server: the
// browser posts to /api/rpc and never sees HELIUS_API_KEY. Without a key the
// public devnet endpoint is used, as before this route existed.
//
// Guards, in order: same-origin only, body size, JSON-RPC shape, method
// allowlist, per-client rate limit. The upstream is fixed to devnet, so the
// route cannot reach mainnet even though the Helius key can.
const PUBLIC_DEVNET_URL = "https://api.devnet.solana.com";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 20;
const UPSTREAM_TIMEOUT_MS = 15_000;

// Methods the dashboard uses: observed from the template flows (balances,
// airdrop, transfer, memo, token) plus SPL balances and recent activity.
const ALLOWED_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getEpochInfo",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getSignatureStatuses",
  "getSignaturesForAddress",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTransaction",
  "requestAirdrop",
  "sendTransaction",
  "simulateTransaction",
]);

// Token bucket per client IP, counted per JSON-RPC call. In memory, so the
// limit is per server instance; Helius plan limits remain the hard ceiling.
const BUCKET_CAPACITY = 40;
const REFILL_PER_SECOND = 10;
const MAX_TRACKED_CLIENTS = 10_000;
const buckets = new Map<string, { tokens: number; updated: number }>();

function takeTokens(client: string, count: number, now: number): boolean {
  let bucket = buckets.get(client);
  if (!bucket) {
    if (buckets.size >= MAX_TRACKED_CLIENTS) buckets.clear();
    bucket = { tokens: BUCKET_CAPACITY, updated: now };
    buckets.set(client, bucket);
  }
  const refill = ((now - bucket.updated) / 1000) * REFILL_PER_SECOND;
  bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + refill);
  bucket.updated = now;
  if (bucket.tokens < count) return false;
  bucket.tokens -= count;
  return true;
}

// The hosting platform sets these headers; behind no proxy they are
// client-controlled and the limit is advisory only.
function clientId(request: Request): string {
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

// A cross-site page can still send a "simple" text/plain POST that skips the
// CORS preflight and executes, so reject any foreign Origin outright.
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function upstreamUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`
    : PUBLIC_DEVNET_URL;
}

function isRpcRequest(value: unknown): value is { method: string } {
  if (typeof value !== "object" || value === null) return false;
  const req = value as Record<string, unknown>;
  return req.jsonrpc === "2.0" && typeof req.method === "string";
}

function reject(
  status: number,
  message: string,
  headers?: HeadersInit
): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32600, message } },
    { status, headers }
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return reject(403, "Cross-origin requests are not allowed");
  }
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return reject(413, "Request too large");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return reject(413, "Request too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return reject(400, "Invalid JSON");
  }
  const calls: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > MAX_BATCH) {
    return reject(400, "Invalid batch size");
  }
  if (!calls.every(isRpcRequest)) {
    return reject(400, "Invalid JSON-RPC request");
  }
  const blocked = calls.find((call) => !ALLOWED_METHODS.has(call.method));
  if (blocked) {
    return reject(403, `Method not allowed: ${blocked.method}`);
  }
  if (!takeTokens(clientId(request), calls.length, Date.now())) {
    return reject(429, "Too many requests", { "retry-after": "1" });
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    // Never echo the upstream error: its message can contain the keyed URL.
    return reject(502, "Upstream RPC unavailable");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
