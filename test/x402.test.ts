import { describe, expect, test } from "vitest";
import { paymentEventSchema } from "../src/model";
import type { WireRequest, WireResponse } from "../src/rails/types";
import { X402Rail } from "../src/rails/x402";

// Synthetic wire examples derived from the primary-source v1/v2 and exact EVM
// specifications linked in SPEC-NOTES.md. These signatures never move funds.
const RESOURCE = "https://api.example.test/premium-data?query=one";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const OTHER_TOKEN = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const NONCE = `0x${"ab".repeat(32)}`;
const TRANSACTION = `0x${"cd".repeat(32)}`;
const BASE_TIME = Date.parse("2026-09-08T12:00:00.000Z");

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function request(headers: Record<string, string> = {}, url = RESOURCE): WireRequest {
  return { url, method: "GET", headers };
}

function authorization() {
  return {
    from: PAYER,
    to: PAY_TO,
    value: "10000",
    validAfter: "1788868700",
    validBefore: "1788872300",
    nonce: NONCE,
  };
}

function requirementsV2() {
  return {
    scheme: "exact",
    network: "eip155:84532",
    asset: TOKEN,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
}

function requirementsV1() {
  const { amount, ...common } = requirementsV2();
  return {
    ...common,
    network: "base-sepolia",
    maxAmountRequired: amount,
    resource: RESOURCE,
    description: "Synthetic premium data",
    mimeType: "application/json",
    outputSchema: null,
  };
}

function payloadV2() {
  return {
    x402Version: 2,
    accepted: requirementsV2(),
    resource: { url: RESOURCE, description: "Synthetic premium data" },
    payload: { signature: `0x${"12".repeat(65)}`, authorization: authorization() },
    extensions: { custom: { info: { preserved: "café" }, schema: {} } },
  };
}

function payloadV1() {
  return {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: { signature: `0x${"12".repeat(65)}`, authorization: authorization() },
  };
}

function signed(value: unknown = payloadV2(), version = 2, headers: Record<string, string> = {}) {
  return request({
    ...headers,
    [version === 1 ? "x-payment" : "payment-signature"]: encode(value),
  });
}

function challengeV1(accepts: unknown[] = [requirementsV1()]): WireResponse {
  return {
    status: 402,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ x402Version: 1, error: "Payment required", accepts })),
  };
}

function challengeV2(): WireResponse {
  return {
    status: 402,
    headers: {
      "payment-required": encode({
        x402Version: 2,
        resource: { url: RESOURCE },
        accepts: [requirementsV2()],
      }),
    },
    body: Buffer.from("<html>Application-selected response body</html>"),
  };
}

function recorder(now: () => number = () => BASE_TIME) {
  const diagnostics: { code: string; resource: string; message: string }[] = [];
  const rail = new X402Rail({
    now,
    diagnostic: (code, resource, message) => diagnostics.push({ code, resource, message }),
  });
  return { rail, diagnostics };
}

function parsedEvent(rail = new X402Rail()) {
  const event = rail.parse(signed());
  expect(event).not.toBeNull();
  if (!event) throw new Error("Expected synthetic EIP-3009 event");
  return event;
}

function settled(overrides: Record<string, unknown> = {}, status = 200): WireResponse {
  return {
    status,
    headers: {
      "payment-response": encode({
        success: true,
        network: "eip155:84532",
        transaction: TRANSACTION,
        payer: PAYER,
        ...overrides,
      }),
    },
  };
}

describe("x402 detection and protocol transparency", () => {
  test("detects challenge and replay signals without claiming ordinary traffic", () => {
    const rail = new X402Rail();
    expect(rail.detect(request())).toBe(false);
    expect(rail.detect(request(), { status: 200, headers: {} })).toBe(false);
    expect(rail.detect(request(), challengeV1())).toBe(true);
    expect(rail.detect(request(), challengeV2())).toBe(true);
    expect(rail.detect(signed())).toBe(true);
    expect(rail.detect(signed(payloadV1(), 1))).toBe(true);
  });

  test("ordinary requests are ignored without diagnostics", () => {
    const { rail, diagnostics } = recorder();
    expect(rail.parse(request())).toBeNull();
    expect(diagnostics).toHaveLength(0);
  });

  test("simultaneous protocol headers cannot select conflicting authorizations", () => {
    const { rail, diagnostics } = recorder();
    expect(rail.parse(signed(payloadV2(), 2, { "x-payment": encode(payloadV1()) }))).toBeNull();
    expect(diagnostics.some((entry) => entry.code === "parse_failed")).toBe(true);
  });

  test("a broken diagnostic sink never throws into the request path", () => {
    const rail = new X402Rail({
      diagnostic: () => {
        throw new Error("Diagnostic storage unavailable");
      },
    });
    expect(() => rail.parse(request({ "payment-signature": "invalid%%%" }))).not.toThrow();
  });

  test.each(["garbled%%%", "", encode("not an object"), encode({}), "bm90IGpzb24="])(
    "malformed signed header %j produces a diagnostic and leaves input intact",
    (value) => {
      const { rail, diagnostics } = recorder();
      const req = request({ "payment-signature": value });
      const original = structuredClone(req);
      expect(rail.parse(req)).toBeNull();
      expect(req).toEqual(original);
      expect(diagnostics.some((entry) => entry.code === "parse_failed")).toBe(true);
    },
  );

  test("unrecognized 402 bytes are left untouched and diagnosed", () => {
    const { rail, diagnostics } = recorder();
    const response = { status: 402, headers: {}, body: Uint8Array.from([255, 0, 13, 10, 65]) };
    const original = Uint8Array.from(response.body);
    expect(rail.parse(request(), response)).toBeNull();
    expect(response.body).toEqual(original);
    expect(diagnostics.some((entry) => entry.code === "parse_failed")).toBe(true);
  });

  test("v2 challenge lives in its header regardless of response body format", () => {
    const { rail, diagnostics } = recorder();
    expect(rail.parse(request(), challengeV2())).toBeNull();
    expect(diagnostics).toHaveLength(0);
  });
});

describe("v2 exact EVM EIP-3009 replay parsing", () => {
  test("parses a self-contained replay without an earlier challenge", () => {
    const { rail } = recorder();
    const event = rail.parse(
      signed(payloadV2(), 2, { "taximeter-task": "task-a", "taximeter-agent": "agent-a" }),
    );
    expect(paymentEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      rail: "x402",
      status: "observed",
      amount: "10000",
      network: "eip155:84532",
      asset: TOKEN.toLowerCase(),
      assetSymbol: "USDC",
      decimals: 6,
      decimalsKnown: true,
      payer: PAYER.toLowerCase(),
      payTo: PAY_TO.toLowerCase(),
      resource: RESOURCE,
      host: "api.example.test",
      taskId: "task-a",
      agentId: "agent-a",
      settlement_unknown: true,
    });
  });

  test("retains original raw JSON, including unknown extensions and leading zeros", () => {
    const rail = new X402Rail();
    const value = payloadV2();
    value.accepted.amount = "00010000";
    value.payload.authorization.value = "00010000";
    value.payload.authorization.validAfter = "0001788868700";
    const event = rail.parse(signed(value));
    expect(event?.amount).toBe("10000");
    expect(JSON.parse(event?.raw ?? "null")).toEqual(value);
  });

  test("preserves integer precision above the safe-number boundary", () => {
    const value = payloadV2();
    value.accepted.amount = "900719925474099312345678";
    value.payload.authorization.value = value.accepted.amount;
    expect(new X402Rail().parse(signed(value))?.amount).toBe(value.accepted.amount);
  });

  test.each([undefined, "0x", `0x${"12".repeat(64)}`, `0x${"12".repeat(500)}`])(
    "allows published optional and variable-length signature shape %j",
    (signature) => {
      const value = { ...payloadV2(), payload: { signature, authorization: authorization() } };
      expect(new X402Rail().parse(signed(value))).not.toBeNull();
    },
  );

  test("resource metadata cannot replace the actual request URL used for host attribution", () => {
    const value = payloadV2();
    value.resource.url = "urn:application:advertised-resource";
    expect(new X402Rail().parse(signed(value))).toMatchObject({
      resource: RESOURCE,
      host: "api.example.test",
    });
  });

  test("optional resource and nullish extension metadata do not discard a payment", () => {
    const value = { ...payloadV2(), resource: null, extensions: null };
    expect(new X402Rail().parse(signed(value))?.amount).toBe("10000");
  });

  test("malformed attribution is diagnosed without dropping known spend", () => {
    const { rail, diagnostics } = recorder();
    const event = rail.parse(
      signed(payloadV2(), 2, { "taximeter-task": "t".repeat(257), "taximeter-agent": "" }),
    );
    expect(event?.amount).toBe("10000");
    expect(event?.taskId).toBeUndefined();
    expect(event?.agentId).toBeUndefined();
    expect(diagnostics.some((entry) => entry.code === "parse_failed")).toBe(true);
  });

  test("unknown tokens retain atomic amounts without trusting spoofed USDC metadata", () => {
    const value = payloadV2();
    value.accepted.asset = OTHER_TOKEN;
    const event = new X402Rail().parse(signed(value));
    expect(event).toMatchObject({
      amount: "10000",
      asset: OTHER_TOKEN,
      decimals: 0,
      decimalsKnown: false,
    });
    expect(event?.assetSymbol).toBeUndefined();
  });

  test("a recognized address on a different chain is a separate, unknown asset", () => {
    const value = payloadV2();
    value.accepted.network = "eip155:1";
    expect(new X402Rail().parse(signed(value))).toMatchObject({
      network: "eip155:1",
      decimalsKnown: false,
    });
  });

  test.each([
    "base-sepolia",
    "solana:mainnet",
    "eip155:0",
    "eip155:-1",
    "eip155:abc",
    "eip155:1.5",
    "",
  ])("unrecognized v2 network %j is transparent and diagnosed", (network) => {
    const { rail, diagnostics } = recorder();
    const value = payloadV2();
    value.accepted.network = network;
    expect(rail.parse(signed(value))).toBeNull();
    expect(diagnostics.some((entry) => entry.code === "parse_failed")).toBe(true);
  });

  test.each([
    "amount",
    "recipient",
    "scheme",
    "transfer-method",
    "mixed-permit2",
    "malformed-nonce",
  ])("does not meter an inconsistent or unsupported %s payload", (variant) => {
    const { rail, diagnostics } = recorder();
    const value = payloadV2();
    let wire: unknown = value;
    if (variant === "amount") value.payload.authorization.value = "10001";
    if (variant === "recipient") value.payload.authorization.to = OTHER_TOKEN;
    if (variant === "scheme") value.accepted.scheme = "upto";
    if (variant === "transfer-method")
      wire = {
        ...value,
        accepted: { ...value.accepted, extra: { assetTransferMethod: "erc7710" } },
      };
    if (variant === "mixed-permit2")
      wire = {
        ...value,
        payload: {
          ...value.payload,
          permit2Authorization: { permitted: { token: TOKEN, amount: "999999999" } },
        },
      };
    if (variant === "malformed-nonce") value.payload.authorization.nonce = "0xab";
    expect(rail.parse(signed(wire))).toBeNull();
    expect(diagnostics.some((entry) => entry.code === "parse_failed")).toBe(true);
  });
});

describe("v1 challenge correlation", () => {
  test("a challenge is not spend, then a matching replay becomes a normalized event", () => {
    const rail = new X402Rail();
    expect(rail.parse(request(), challengeV1())).toBeNull();
    expect(rail.parse(signed(payloadV1(), 1))).toMatchObject({
      amount: "10000",
      network: "eip155:84532",
      asset: TOKEN.toLowerCase(),
    });
  });

  test("legacy Base maps to its independent network and known asset", () => {
    const rail = new X402Rail();
    const requirement = {
      ...requirementsV1(),
      network: "base",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    };
    rail.parse(request(), challengeV1([requirement]));
    const value = { ...payloadV1(), network: "base" };
    expect(rail.parse(signed(value, 1))).toMatchObject({
      network: "eip155:8453",
      assetSymbol: "USDC",
      decimalsKnown: true,
    });
  });

  test("cannot infer an asset when no prior challenge was observed", () => {
    const { rail, diagnostics } = recorder();
    expect(rail.parse(signed(payloadV1(), 1))).toBeNull();
    expect(diagnostics.some((entry) => entry.code === "parse_failed")).toBe(true);
  });

  test("selects the uniquely matching recipient and amount among accepts", () => {
    const rail = new X402Rail();
    rail.parse(
      request(),
      challengeV1([{ ...requirementsV1(), maxAmountRequired: "99" }, requirementsV1()]),
    );
    expect(rail.parse(signed(payloadV1(), 1))?.amount).toBe("10000");
  });

  test("does not guess between compatible accepts with different assets", () => {
    const rail = new X402Rail();
    rail.parse(
      request(),
      challengeV1([requirementsV1(), { ...requirementsV1(), asset: OTHER_TOKEN }]),
    );
    expect(rail.parse(signed(payloadV1(), 1))).toBeNull();
  });

  test.each(["taximeter-task", "taximeter-agent", "authorization", "cookie"])(
    "isolates challenge context by %s",
    (header) => {
      const rail = new X402Rail();
      rail.parse(request({ [header]: "first" }), challengeV1());
      expect(rail.parse(signed(payloadV1(), 1, { [header]: "second" }))).toBeNull();
      expect(rail.parse(signed(payloadV1(), 1, { [header]: "first" }))).not.toBeNull();
    },
  );

  test("isolates challenges by method and full actual resource URL", () => {
    const rail = new X402Rail();
    rail.parse(request(), challengeV1());
    expect(rail.parse({ ...signed(payloadV1(), 1), method: "POST" })).toBeNull();
    expect(rail.parse({ ...signed(payloadV1(), 1), url: `${RESOURCE}&other=1` })).toBeNull();
  });

  test("expires a challenge after five minutes", () => {
    let now = BASE_TIME;
    const { rail } = recorder(() => now);
    rail.parse(request(), challengeV1());
    now += 300001;
    expect(rail.parse(signed(payloadV1(), 1))).toBeNull();
  });

  test("bounded challenge storage evicts old contexts", () => {
    const rail = new X402Rail();
    for (let index = 0; index < 1001; index++) {
      rail.parse(request({}, `${RESOURCE}&context=${index}`), challengeV1());
    }
    expect(rail.parse({ ...signed(payloadV1(), 1), url: `${RESOURCE}&context=0` })).toBeNull();
    expect(
      rail.parse({ ...signed(payloadV1(), 1), url: `${RESOURCE}&context=1000` }),
    ).not.toBeNull();
  });

  test("unsupported legacy names stay transparent", () => {
    const rail = new X402Rail();
    rail.parse(request(), challengeV1([{ ...requirementsV1(), network: "ethereum" }]));
    expect(rail.parse(signed({ ...payloadV1(), network: "ethereum" }, 1))).toBeNull();
  });
});

describe("authorization identity", () => {
  test("signature, checksum casing, and resource changes do not duplicate an authorization", () => {
    const rail = new X402Rail();
    const first = parsedEvent(rail);
    const value = payloadV2();
    value.payload.signature = "0xabcd";
    value.payload.authorization.from = PAYER.toLowerCase();
    value.payload.authorization.to = PAY_TO.toLowerCase();
    value.accepted.payTo = PAY_TO.toLowerCase();
    value.accepted.asset = TOKEN.toLowerCase();
    const replay = rail.parse({ ...signed(value), url: "https://other.example.test/data" });
    expect(replay?.paymentKey).toBe(first.paymentKey);
  });

  test.each([
    "network",
    "asset",
    "payer",
    "nonce",
    "amount",
    "recipient",
    "validAfter",
    "validBefore",
  ])("changed %s produces a different identity", (field) => {
    const rail = new X402Rail();
    const first = parsedEvent(rail);
    const value = payloadV2();
    if (field === "network") value.accepted.network = "eip155:1";
    if (field === "asset") value.accepted.asset = OTHER_TOKEN;
    if (field === "payer") value.payload.authorization.from = OTHER_TOKEN;
    if (field === "nonce") value.payload.authorization.nonce = `0x${"ef".repeat(32)}`;
    if (field === "amount") {
      value.accepted.amount = "20000";
      value.payload.authorization.value = "20000";
    }
    if (field === "recipient") {
      value.accepted.payTo = OTHER_TOKEN;
      value.payload.authorization.to = OTHER_TOKEN;
    }
    if (field === "validAfter") value.payload.authorization.validAfter = "1788868699";
    if (field === "validBefore") value.payload.authorization.validBefore = "1788872301";
    const changed = rail.parse(signed(value));
    expect(changed).not.toBeNull();
    expect(changed?.paymentKey).not.toBe(first.paymentKey);
  });
});

describe("settlement evidence", () => {
  test.each([200, 402, 500])(
    "recognizes matching explicit settlement evidence even on HTTP %i",
    (status) => {
      const rail = new X402Rail();
      expect(rail.settlement(parsedEvent(rail), settled({}, status))).toMatchObject({
        status: "confirmed",
        txHash: TRANSACTION,
      });
    },
  );

  test("maps the v1 settlement header and legacy network", () => {
    const rail = new X402Rail();
    const response = settled({ network: "base-sepolia" });
    const value = response.headers["payment-response"];
    if (!value) throw new Error("Expected synthetic settlement header");
    expect(
      rail.settlement(parsedEvent(rail), { status: 200, headers: { "x-payment-response": value } }),
    ).toMatchObject({ status: "confirmed", txHash: TRANSACTION });
  });

  test("optional payer and amount can be omitted", () => {
    const rail = new X402Rail();
    expect(rail.settlement(parsedEvent(rail), settled({ payer: undefined }))).toMatchObject({
      status: "confirmed",
    });
  });

  test("canonicalizes an explicit atomic settlement amount", () => {
    const rail = new X402Rail();
    expect(rail.settlement(parsedEvent(rail), settled({ amount: "00010000" }))).toMatchObject({
      status: "confirmed",
    });
  });

  test.each([
    { network: "eip155:1" },
    { payer: OTHER_TOKEN },
    { amount: "1" },
    { transaction: "" },
  ])("inconsistent settlement %j remains unknown", (overrides) => {
    const rail = new X402Rail();
    expect(rail.settlement(parsedEvent(rail), settled(overrides)).status).toBe("unknown");
  });

  test("records an explicit failed settlement without claiming a transaction", () => {
    const rail = new X402Rail();
    expect(
      rail.settlement(
        parsedEvent(rail),
        settled({ success: false, transaction: "", errorReason: "insufficient_funds" }, 402),
      ),
    ).toMatchObject({ status: "failed", reason: "insufficient_funds" });
  });

  test("failed settlement reported alongside a server failure remains conservatively unknown", () => {
    const rail = new X402Rail();
    expect(
      rail.settlement(
        parsedEvent(rail),
        settled({ success: false, transaction: "", errorReason: "unexpected_settle_error" }, 500),
      ).status,
    ).toBe("unknown");
  });

  test.each([200, 402, 500])("missing settlement header on HTTP %i remains unknown", (status) => {
    const rail = new X402Rail();
    expect(rail.settlement(parsedEvent(rail), { status, headers: {} }).status).toBe("unknown");
  });

  test("malformed settlement headers remain unknown", () => {
    const rail = new X402Rail();
    expect(
      rail.settlement(parsedEvent(rail), {
        status: 200,
        headers: { "payment-response": "not-json%%%" },
      }).status,
    ).toBe("unknown");
  });
});
