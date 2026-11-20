// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { POST } from "../app/api/rpc/route";

const call = { jsonrpc: "2.0", id: 1, method: "getBalance", params: [] };
let clientCounter = 0;

// Each request gets its own client IP unless one is given, so the in-memory
// rate limit does not couple tests.
function post(body: string, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/rpc", {
      method: "POST",
      body,
      headers: {
        host: "localhost",
        "x-real-ip": `10.0.0.${++clientCounter}`,
        ...headers,
      },
    })
  );
}

function stubUpstream() {
  const upstream = vi.fn(async () =>
    Response.json({ jsonrpc: "2.0", id: 1, result: "ok" })
  );
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("forwards to Helius devnet with the server-side key", async () => {
  vi.stubEnv("HELIUS_API_KEY", "test-key");
  const upstream = stubUpstream();
  const res = await post(JSON.stringify(call));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ result: "ok" });
  expect(upstream).toHaveBeenCalledWith(
    "https://devnet.helius-rpc.com/?api-key=test-key",
    expect.objectContaining({ method: "POST" })
  );
});

test("uses public devnet when no key is configured", async () => {
  vi.stubEnv("HELIUS_API_KEY", "");
  const upstream = stubUpstream();
  await post(JSON.stringify(call));
  expect(upstream).toHaveBeenCalledWith(
    "https://api.devnet.solana.com",
    expect.anything()
  );
});

test("allows a same-origin browser request", async () => {
  stubUpstream();
  const res = await post(JSON.stringify(call), {
    origin: "http://localhost",
  });
  expect(res.status).toBe(200);
});

test.each([
  ["invalid JSON", "{", {}, 400],
  ["non JSON-RPC body", JSON.stringify({ method: "getBalance" }), {}, 400],
  ["empty batch", "[]", {}, 400],
  ["oversized batch", JSON.stringify(Array(21).fill(call)), {}, 400],
  [
    "oversized body",
    JSON.stringify({ ...call, pad: "x".repeat(70_000) }),
    {},
    413,
  ],
  [
    "a method outside the allowlist",
    JSON.stringify({ ...call, method: "getProgramAccounts" }),
    {},
    403,
  ],
  [
    "a batch hiding a disallowed method",
    JSON.stringify([call, { ...call, method: "getProgramAccounts" }]),
    {},
    403,
  ],
  [
    "an inherited object key as method",
    JSON.stringify({ ...call, method: "constructor" }),
    {},
    403,
  ],
  [
    "a cross-origin request",
    JSON.stringify(call),
    { origin: "https://evil.example" },
    403,
  ],
  ["a malformed origin", JSON.stringify(call), { origin: "not a url" }, 403],
])(
  "rejects %s without calling upstream",
  async (_name, body, headers, status) => {
    const upstream = stubUpstream();
    const res = await post(body, headers);
    expect(res.status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  }
);

test("rate limits a client per call, not per request", async () => {
  // Freeze the clock so no tokens refill mid-test.
  vi.useFakeTimers({ toFake: ["Date"] });
  const upstream = stubUpstream();
  const ip = { "x-real-ip": "192.0.2.1" };
  const batch = JSON.stringify(Array(20).fill(call));
  expect((await post(batch, ip)).status).toBe(200);
  expect((await post(batch, ip)).status).toBe(200);
  const limited = await post(JSON.stringify(call), ip);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("1");
  expect(upstream).toHaveBeenCalledTimes(2);
  // Another client is unaffected; the limited one recovers after a second.
  expect((await post(JSON.stringify(call))).status).toBe(200);
  vi.advanceTimersByTime(1_000);
  expect((await post(JSON.stringify(call), ip)).status).toBe(200);
  vi.useRealTimers();
});

test("upstream failure does not leak the keyed URL", async () => {
  vi.stubEnv("HELIUS_API_KEY", "secret-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      throw new Error(`connect failed ${url}`);
    })
  );
  const res = await post(JSON.stringify(call));
  expect(res.status).toBe(502);
  expect(await res.text()).not.toContain("secret-key");
});
