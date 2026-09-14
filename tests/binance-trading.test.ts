import { test } from "node:test";
import assert from "node:assert/strict";
import { BinanceTradingClient, BinanceTradingError } from "../server/binance-trading";

const baseConfig = { environment: "demo" as const, apiKey: "X".repeat(40), apiSecret: "Y".repeat(64) };

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

test("trading client reports a clean configuration when both key and secret are present", () => {
  const client = new BinanceTradingClient(baseConfig);
  assert.equal(client.configured, true);
  assert.equal(client.configurationIssue, null);
  assert.equal(client.environment, "demo");
  assert.equal(client.baseUrl, "https://demo-fapi.binance.com");
});

test("trading client rejects partially populated credentials", () => {
  const client = new BinanceTradingClient({ environment: "demo", apiKey: "X".repeat(40) });
  assert.equal(client.configured, false);
  assert.match(client.configurationIssue ?? "", /同时配置/);
});

test("trading client rejects PEM private keys", () => {
  const client = new BinanceTradingClient({ environment: "demo", apiKey: "X".repeat(40), apiSecret: "-----BEGIN PRIVATE KEY-----" });
  assert.equal(client.configured, false);
  assert.match(client.configurationIssue ?? "", /HMAC/);
});

test("trading client surfaces a 429 response as a bounded backoff", async () => {
  const now = Date.now();
  const fetchMock = mockFetch(async (url) => {
    if (url.endsWith("/fapi/v1/time")) return new Response(JSON.stringify({ serverTime: now }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 429, headers: { "retry-after": "1" } });
  });
  const client = new BinanceTradingClient(baseConfig, { fetch: fetchMock, now: () => now });
  await assert.rejects(
    client.placeLimitOrder({ symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "60000" }),
    (err: unknown) => err instanceof BinanceTradingError && err.code === "RATE_LIMIT",
  );
  assert(client.blockedUntil > Date.now());
});

test("trading client surfaces a 401 response as AUTH_REJECTED", async () => {
  const now = Date.now();
  const fetchMock = mockFetch(async (url) => {
    if (url.endsWith("/fapi/v1/time")) return new Response(JSON.stringify({ serverTime: now }), { status: 200 });
    return new Response(JSON.stringify({ code: -2015, msg: "Invalid API-key" }), { status: 401 });
  });
  const client = new BinanceTradingClient(baseConfig, { fetch: fetchMock, now: () => now });
  await assert.rejects(
    client.placeLimitOrder({ symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "60000" }),
    (err: unknown) => err instanceof BinanceTradingError && err.code === "AUTH_REJECTED",
  );
});

test("trading client maps code -1021 to TIMESTAMP_REJECTED", async () => {
  const now = Date.now();
  const fetchMock = mockFetch(async (url) => {
    if (url.endsWith("/fapi/v1/time")) return new Response(JSON.stringify({ serverTime: now }), { status: 200 });
    return new Response(JSON.stringify({ code: -1021, msg: "Timestamp outside recvWindow" }), { status: 400 });
  });
  const client = new BinanceTradingClient(baseConfig, { fetch: fetchMock, now: () => now });
  await assert.rejects(
    client.placeLimitOrder({ symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "60000" }),
    (err: unknown) => err instanceof BinanceTradingError && err.code === "TIMESTAMP_REJECTED",
  );
});

test("trading client surfaces a clean 200 newOrder response as a normalised order", async () => {
  const now = Date.now();
  const fetchMock = mockFetch(async (url) => {
    if (url.endsWith("/fapi/v1/time")) return new Response(JSON.stringify({ serverTime: now }), { status: 200 });
    return new Response(JSON.stringify({
      symbol: "BTCUSDT", orderId: 123, side: "BUY", type: "LIMIT", status: "NEW",
      price: "60000", origQty: "0.001", executedQty: "0", timeInForce: "GTX",
      updateTime: now, time: now,
    }), { status: 200, headers: { "x-mbx-used-weight-1m": "5" } });
  });
  const client = new BinanceTradingClient(baseConfig, { fetch: fetchMock, now: () => now });
  const order = await client.placeLimitOrder({ symbol: "BTCUSDT", side: "BUY", quantity: "0.001", price: "60000", reduceOnly: false });
  assert.equal(order.orderId, '123');
  assert.equal(order.symbol, "BTCUSDT");
  assert.equal(order.status, "NEW");
  assert.equal(order.timeInForce, "GTX");
  assert.equal(client.status().lastWeight, 5);
});

test("trading client synchronises the clock from /fapi/v1/time", async () => {
  const now = 1_700_000_000_000;
  let callCount = 0;
  const fetchMock = mockFetch(async () => {
    callCount++;
    if (callCount === 1) return new Response(JSON.stringify({ serverTime: now + 25 }), { status: 200 });
    return new Response(JSON.stringify({
      totalWalletBalance: "100", totalUnrealizedProfit: "0", totalMarginBalance: "100",
      availableBalance: "100", maxWithdrawAmount: "100", assets: [], positions: [],
    }), { status: 200 });
  });
  const client = new BinanceTradingClient(baseConfig, { fetch: fetchMock, now: () => now });
  const account = await client.getAccount();
  assert.equal(account.totalWalletBalance, "100");
  assert.equal(account.assets.length, 0);
  assert.equal(account.positions.length, 0);
  assert(callCount >= 1);
});

test("configure() swaps credentials, environment and resets rate-limit state at runtime", () => {
  const client = new BinanceTradingClient(baseConfig);
  assert.equal(client.configured, true);
  assert.equal(client.apiKeyTail(), "XXXX");
  // Simulate a used rate-limit window.
  (client as unknown as { "#orderTimestamps": number[] })["#orderTimestamps"] = [Date.now()];
  client.configure({ environment: "production", apiKey: "A", apiSecret: "B" });
  assert.equal(client.configured, false);          // key/secret too short -> invalid
  assert.equal(client.status().ordersThisMinute, 0); // slots were cleared
  client.configure({ environment: "production", apiKey: "Z".repeat(40), apiSecret: "Q".repeat(64) });
  assert.equal(client.configured, true);
  assert.equal(client.environment, "production");
  assert.equal(client.baseUrl, "https://fapi.binance.com");
  assert.equal(client.apiKeyTail(), "ZZZZ");
});

test("configure() keeps working when credentials are omitted (clears to unconfigured)", () => {
  const client = new BinanceTradingClient(baseConfig);
  client.configure({ environment: "demo" });
  assert.equal(client.configured, false);
  assert.match(client.configurationIssue ?? "", /尚未配置/);
});
