import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { payloadV1Schema, payloadV2Schema } from "../../src/rails/schemas";

export const fixtureAsset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const fixtureRecipient = "0x209693bc6afc0c5328ba36faf03c514ef312287c";
export const fixturePayer = "0x857b06519e91e3a54538791bdbb0e22373e36b66";
export const opaqueBody = gzipSync(Buffer.from([0, 255, 13, 10, 34, 123, 128, 42, 0, 99]));
export const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64");

export function requirements(version: 1 | 2, resource: string, amount = "7") {
  const common = {
    scheme: "exact",
    network: version === 1 ? "base" : "eip155:8453",
    asset: fixtureAsset,
    payTo: fixtureRecipient,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
  return version === 1
    ? {
        ...common,
        maxAmountRequired: amount,
        resource,
        description: "Synthetic fixture",
        mimeType: "application/json",
      }
    : { ...common, amount };
}
export function paymentHeader(
  version: 1 | 2,
  nonce: number,
  resource: string,
  amount = "7",
): Record<string, string> {
  const payload = {
    signature: `0x${"12".repeat(65)}`,
    authorization: {
      from: fixturePayer,
      to: fixtureRecipient,
      value: amount,
      validAfter: "0",
      validBefore: "9999999999",
      nonce: `0x${nonce.toString(16).padStart(64, "0")}`,
    },
  };
  return version === 1
    ? { "x-payment": encode({ x402Version: 1, scheme: "exact", network: "base", payload }) }
    : {
        "payment-signature": encode({
          x402Version: 2,
          accepted: requirements(2, resource, amount),
          resource: { url: resource },
          payload,
        }),
      };
}

export async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return z.object({ port: z.number() }).parse(server.address()).port;
}
export async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function fixtureUpstream() {
  let paid = 0;
  const requests: { url: string; method: string; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: unknown) => chunks.push(z.instanceof(Buffer).parse(chunk)));
    req.on("end", () => {
      const resource = `http://${req.headers.host}${req.url}`;
      const url = new URL(resource);
      requests.push({
        url: req.url ?? "/",
        method: req.method ?? "GET",
        body: Buffer.concat(chunks),
      });
      if (url.pathname === "/unknown") {
        res.writeHead(402, {
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "gzip",
          "Content-Length": opaqueBody.length,
          "Set-Cookie": ["a=1", "b=2"],
        });
        res.end(opaqueBody);
        return;
      }
      if (url.pathname === "/large") {
        res.writeHead(402);
        res.end(Buffer.alloc(100_000, 255));
        return;
      }
      if (url.pathname === "/echo") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.concat(chunks));
        return;
      }
      if (url.pathname === "/trailers") {
        res.writeHead(200, { Trailer: "X-Fixture-End", "Set-Cookie": ["a=1", "b=2"] });
        res.write("first");
        res.addTrailers({ "X-Fixture-End": "yes" });
        res.end("second");
        return;
      }
      const version = url.pathname === "/v1" ? 1 : 2;
      const header = req.headers[version === 1 ? "x-payment" : "payment-signature"];
      if (!header) {
        const challenge = {
          x402Version: version,
          accepts: [requirements(version, resource)],
          ...(version === 2 ? { resource: { url: resource } } : {}),
        };
        res.writeHead(
          402,
          version === 2
            ? { "PAYMENT-REQUIRED": encode(challenge) }
            : { "Content-Type": "application/json" },
        );
        res.end(version === 1 ? JSON.stringify(challenge) : "application body");
        return;
      }
      const value = z.string().parse(header);
      const data: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
      const parsed =
        version === 1 ? payloadV1Schema.safeParse(data) : payloadV2Schema.safeParse(data);
      if (!parsed.success) {
        res.writeHead(400);
        res.end("invalid fixture payment");
        return;
      }
      paid += 1;
      if (url.pathname === "/disconnect") {
        req.socket.destroy();
        return;
      }
      const parameters = z
        .object({
          status: z.coerce.number().int().min(200).max(599).default(200),
          delay: z.coerce.number().int().min(0).max(1000).default(0),
          settlement: z.enum(["success", "failed", "none"]).default("success"),
        })
        .parse(Object.fromEntries(url.searchParams));
      const reply = () => {
        if (parameters.settlement !== "none")
          res.setHeader(
            version === 1 ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE",
            encode({
              success: parameters.settlement === "success",
              transaction:
                parameters.settlement === "success"
                  ? `0x${parsed.data.payload.authorization.nonce.slice(2)}`
                  : "",
              network: version === 1 ? "base" : "eip155:8453",
              payer: fixturePayer,
            }),
          );
        res.writeHead(parameters.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: parameters.status === 200 }));
      };
      if (parameters.delay) setTimeout(reply, parameters.delay);
      else reply();
    });
  });
  const port = await listen(server);
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    paid: () => paid,
    requests,
    close: () => stop(server),
  };
}
