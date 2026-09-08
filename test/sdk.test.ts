import { createServer } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseConfig } from "../src/config";
import { totals } from "../src/ledger/derive";
import { Ledger } from "../src/ledger/store";
import { blockedBodySchema } from "../src/model";
import { withMeter } from "../src/sdk/index";
import {
  encode,
  fixturePayer,
  fixtureUpstream,
  listen,
  paymentHeader,
  stop,
} from "./fixtures/upstream";

const RESOURCE = "https://api.example.test/data";
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function ledger(): Ledger {
  const store = new Ledger(":memory:");
  cleanup.push(() => store.close());
  return store;
}

function cap(amount = "14") {
  return parseConfig({
    budgets: { perTask: null, perAgent: null, global: { amount, asset: "USDC", window: "24h" } },
    policy: { maxSinglePayment: null },
  });
}

function confirmation(): Response {
  return new Response("paid content", {
    status: 200,
    headers: {
      "payment-response": encode({
        success: true,
        network: "eip155:8453",
        payer: fixturePayer,
        transaction: `0x${"ab".repeat(32)}`,
      }),
    },
  });
}

// Simulate the official payment wrapper's composition without wallets or SDK
// dependencies: the supplied metered transport sees both HTTP exchanges.
function paymentWrapper(transport: typeof globalThis.fetch, version: 1 | 2) {
  return async (url: string, nonce: number): Promise<Response> => {
    const offered = await transport(url);
    if (offered.status !== 402) return offered;
    await offered.arrayBuffer();
    return transport(url, { headers: paymentHeader(version, nonce, url) });
  };
}

describe("SDK composition and exact budget enforcement", () => {
  test.each([1, 2] as const)(
    "meters a real local v%i challenge and replay through the supplied transport",
    async (version) => {
      const upstream = await fixtureUpstream();
      cleanup.push(() => upstream.close());
      const store = ledger();
      const metered = withMeter(fetch, {
        ledger: store,
        config: cap(),
        taskId: "sdk-task",
        agentId: "sdk-agent",
      });
      const paidFetch = paymentWrapper(metered, version);
      const url = `${upstream.url}/v${version}`;
      for (const nonce of [1, 2]) {
        const result = await paidFetch(url, nonce);
        expect(result.status).toBe(200);
        await result.arrayBuffer();
      }
      const blocked = await paidFetch(url, 3);
      expect(blocked.status).toBe(402);
      expect(blockedBodySchema.parse(await blocked.json())).toMatchObject({
        error: "blocked_by_taximeter",
        budget: "14",
        spent: "14",
        remaining: "0",
      });
      expect(upstream.paid()).toBe(2);
      expect(totals(store.view())[0]?.amount).toBe("14");
      expect(store.view().filter((row) => row.status === "blocked")).toHaveLength(1);
      expect(
        store
          .view()
          .filter((row) => row.status === "observed")
          .every((row) => row.taskId === "sdk-task" && row.agentId === "sdk-agent"),
      ).toBe(true);
    },
  );

  test("simultaneous signed requests reserve capacity before awaiting upstream responses", async () => {
    const upstream = await fixtureUpstream();
    cleanup.push(() => upstream.close());
    const store = ledger();
    const metered = withMeter(fetch, { ledger: store, config: cap() });
    const url = `${upstream.url}/v2?delay=30`;
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        metered(url, { headers: paymentHeader(2, index + 1, url) }),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(2);
    expect(responses.filter((response) => response.status === 402)).toHaveLength(10);
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    expect(upstream.paid()).toBe(2);
    expect(totals(store.view())[0]?.amount).toBe("14");
  });

  test("SDK attribution options override headers without mutating the input Request", async () => {
    const store = ledger();
    const transport: typeof globalThis.fetch = async () => confirmation();
    const metered = withMeter(transport, {
      ledger: store,
      config: cap(),
      taskId: "option-task",
      agentId: "option-agent",
    });
    const original = new Request(RESOURCE, {
      headers: {
        ...paymentHeader(2, 1, RESOURCE),
        "Taximeter-Task": "header-task",
        "Taximeter-Agent": "header-agent",
      },
    });
    await metered(original);
    expect(store.view()[0]).toMatchObject({ taskId: "option-task", agentId: "option-agent" });
    expect(original.headers.get("Taximeter-Task")).toBe("header-task");
    expect(original.headers.get("Taximeter-Agent")).toBe("header-agent");
  });

  test("request attribution is preserved when options omit it", async () => {
    const store = ledger();
    const transport: typeof globalThis.fetch = async () => confirmation();
    const metered = withMeter(transport, { ledger: store, config: cap() });
    await metered(RESOURCE, {
      headers: { ...paymentHeader(2, 1, RESOURCE), "Taximeter-Task": "header-task" },
    });
    expect(store.view()[0]?.taskId).toBe("header-task");
  });
});

describe("SDK preserves fetch request and response behavior", () => {
  test("Request input, POST method, binary body, and response bytes pass unchanged", async () => {
    const upstream = await fixtureUpstream();
    cleanup.push(() => upstream.close());
    const store = ledger();
    const metered = withMeter(fetch, { ledger: store, config: cap() });
    const bytes = Uint8Array.from([0, 255, 13, 10, 123, 128, 42]);
    const input = new Request(`${upstream.url}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    const response = await metered(input);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(upstream.requests[0]).toMatchObject({ method: "POST", body: Buffer.from(bytes) });
    expect(store.events()).toHaveLength(0);
  });

  test("normal response keeps its identity and is never cloned or consumed", async () => {
    const store = ledger();
    const original = new Response("unconsumed body", { status: 200 });
    const clone = vi.spyOn(original, "clone");
    const transport: typeof globalThis.fetch = async () => original;
    const metered = withMeter(transport, { ledger: store, config: cap() });
    const response = await metered(RESOURCE);
    expect(response).toBe(original);
    expect(response.bodyUsed).toBe(false);
    expect(clone).not.toHaveBeenCalled();
    expect(await response.text()).toBe("unconsumed body");
  });

  test("paid response also retains identity and an unread body", async () => {
    const store = ledger();
    const original = confirmation();
    const transport: typeof globalThis.fetch = async () => original;
    const metered = withMeter(transport, { ledger: store, config: cap() });
    const response = await metered(RESOURCE, { headers: paymentHeader(2, 1, RESOURCE) });
    expect(response).toBe(original);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("paid content");
    expect(store.view()[0]?.settlementStatus).toBe("confirmed");
  });

  test("abort signals remain linked to the supplied transport", async () => {
    const store = ledger();
    const abort = new AbortController();
    let started: (() => void) | undefined;
    const transportStarted = new Promise<void>((done) => {
      started = done;
    });
    const transport: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      started?.();
      return new Promise<Response>((_done, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        else
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
      });
    };
    const metered = withMeter(transport, { ledger: store, config: cap() });
    const result = metered(RESOURCE, { signal: abort.signal });
    await transportStarted;
    const reason = new Error("user cancelled");
    abort.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(store.events()).toHaveLength(0);
  });

  test("a pre-aborted signed request does not reserve spend", async () => {
    const store = ledger();
    const abort = new AbortController();
    abort.abort();
    const transport: typeof globalThis.fetch = async (input, init) => {
      new Request(input, init).signal.throwIfAborted();
      return confirmation();
    };
    const metered = withMeter(transport, { ledger: store, config: cap() });
    await expect(
      metered(RESOURCE, { signal: abort.signal, headers: paymentHeader(2, 1, RESOURCE) }),
    ).rejects.toThrow();
    expect(store.events()).toHaveLength(0);
  });

  test("an upstream exception after authorization preserves both the original error and uncertain spend", async () => {
    const store = ledger();
    const failure = new Error("socket disconnected after replay");
    const transport: typeof globalThis.fetch = async () => {
      throw failure;
    };
    const metered = withMeter(transport, { ledger: store, config: cap() });
    await expect(metered(RESOURCE, { headers: paymentHeader(2, 1, RESOURCE) })).rejects.toBe(
      failure,
    );
    expect(store.view()[0]).toMatchObject({
      amount: "7",
      settlementStatus: "unknown",
      settlement_unknown: true,
    });
    expect(totals(store.view())[0]?.amount).toBe("7");
  });
});

describe("SDK unknown traffic observation is bounded and transparent", () => {
  test("native fetch redirects remain transparent and diagnose policy visibility limits", async () => {
    const destination = await fixtureUpstream();
    cleanup.push(() => destination.close());
    const redirected = `${destination.url.replace("127.0.0.1", "localhost")}/v2`;
    const origin = createServer((_request, response) => {
      response.writeHead(302, { Location: redirected });
      response.end();
    });
    const port = await listen(origin);
    cleanup.push(() => stop(origin));
    const url = `http://127.0.0.1:${port}/payment`;
    const store = ledger();
    let forwarded: RequestInit | undefined;
    let original: Response | undefined;
    const transport: typeof globalThis.fetch = async (input, init) => {
      forwarded = init;
      original = await fetch(input, init);
      return original;
    };
    const metered = withMeter(transport, {
      ledger: store,
      config: parseConfig(cap(), { policy: { denyHosts: ["localhost"] } }),
    });
    const init: RequestInit = { headers: paymentHeader(2, 1, url), redirect: "follow" };
    const response = await metered(url, init);
    expect(response).toBe(original);
    expect(forwarded).toBe(init);
    expect(response.redirected).toBe(true);
    expect(response.url).toBe(redirected);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    // Native fetch's hidden hop reaches this host before the wrapper sees the response.
    expect(destination.paid()).toBe(1);
    expect(store.view()[0]?.host).toBe("127.0.0.1");
    expect(store.diagnostics().some((entry) => entry.message.includes("redirect internally"))).toBe(
      true,
    );
  });

  test("redirected legacy challenges are not correlated to the initial request URL", async () => {
    const destination = await fixtureUpstream();
    cleanup.push(() => destination.close());
    const origin = createServer((_request, response) => {
      response.writeHead(302, { Location: `${destination.url}/v1` });
      response.end();
    });
    const port = await listen(origin);
    cleanup.push(() => stop(origin));
    const url = `http://127.0.0.1:${port}/payment`;
    const store = ledger();
    const metered = withMeter(fetch, { ledger: store, config: cap() });
    const challenge = await metered(url);
    expect(challenge.redirected).toBe(true);
    expect(challenge.status).toBe(402);
    expect(await challenge.json()).toMatchObject({ x402Version: 1 });
    const replay = await metered(url, { headers: paymentHeader(1, 1, url) });
    expect(replay.status).toBe(200);
    await replay.arrayBuffer();
    expect(destination.paid()).toBe(1);
    expect(store.events()).toEqual([]);
    expect(store.diagnostics().some((entry) => entry.message.includes("redirect internally"))).toBe(
      true,
    );
  });

  test("a malformed payment header is forwarded and diagnosed", async () => {
    const store = ledger();
    let forwardedHeader: string | null = null;
    const original = new Response("upstream understands its own request");
    const transport: typeof globalThis.fetch = async (input, init) => {
      forwardedHeader = new Request(input, init).headers.get("payment-signature");
      return original;
    };
    const metered = withMeter(transport, { ledger: store, config: cap() });
    expect(await metered(RESOURCE, { headers: { "payment-signature": "invalid%%%" } })).toBe(
      original,
    );
    expect(forwardedHeader).toBe("invalid%%%");
    expect(store.events()).toHaveLength(0);
    expect(store.diagnostics().some((entry) => entry.code === "parse_failed")).toBe(true);
  });

  test("unknown 402 binary content returns the original response and exact bytes", async () => {
    const store = ledger();
    const bytes = Uint8Array.from([255, 0, 13, 10, 128]);
    const original = new Response(bytes, { status: 402 });
    const transport: typeof globalThis.fetch = async () => original;
    const response = await withMeter(transport, { ledger: store, config: cap() })(RESOURCE);
    expect(response).toBe(original);
    expect(response.bodyUsed).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(store.diagnostics().some((entry) => entry.code === "parse_failed")).toBe(true);
  });

  test("oversized 402 content is not truncated or consumed by the observer", async () => {
    const store = ledger();
    const bytes = new Uint8Array(70_000).fill(255);
    const original = new Response(bytes, { status: 402 });
    const transport: typeof globalThis.fetch = async () => original;
    const response = await withMeter(transport, { ledger: store, config: cap() })(RESOURCE);
    expect(response).toBe(original);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(store.diagnostics().some((entry) => entry.code === "parse_failed")).toBe(true);
  });

  test("an unfinished streaming 402 returns after the bounded observation delay", async () => {
    const store = ledger();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode("partial challenge"));
        },
      }),
      { status: 402 },
    );
    const transport: typeof globalThis.fetch = async () => original;
    const metered = withMeter(transport, { ledger: store, config: cap() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const returned = await Promise.race([
        metered(RESOURCE),
        new Promise<never>((_done, reject) => {
          timer = setTimeout(
            () => reject(new Error("Observer stalled fetch for more than one second")),
            1000,
          );
        }),
      ]);
      expect(returned).toBe(original);
      expect(returned.bodyUsed).toBe(false);
      streamController?.close();
      streamController = undefined;
      expect(await returned.text()).toBe("partial challenge");
      expect(store.diagnostics().some((entry) => entry.code === "parse_failed")).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      streamController?.close();
    }
  });
});

describe("SDK options and ledger ownership", () => {
  test("close leaves an injected ledger available to its owner", () => {
    const store = ledger();
    const metered = withMeter(fetch, { ledger: store, config: cap() });
    expect(metered.ledger).toBe(store);
    metered.close();
    metered.close();
    expect(store.events()).toEqual([]);
  });

  test("close closes a ledger created by the wrapper", () => {
    const metered = withMeter(fetch, { db: ":memory:", config: cap() });
    expect(metered.ledger.events()).toEqual([]);
    metered.close();
    expect(() => metered.ledger.events()).toThrow();
  });

  test.each([
    { taskId: "" },
    { agentId: "a".repeat(257) },
    { db: "" },
    { config: { budgets: { global: { amount: "1.5" } } } },
    { config: { policy: { unsupported: true } } },
    { unsupported: true },
  ])("invalid external options %j are rejected before use", (options) => {
    const store = ledger();
    expect(() =>
      Reflect.apply(withMeter, undefined, [fetch, { ledger: store, ...options }]),
    ).toThrow();
  });
});
