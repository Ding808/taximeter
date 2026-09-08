import { createServer, request } from "node:http";
import { expect, test } from "vitest";
import { z } from "zod";
import { parseConfig } from "../src/config";
import { Ledger } from "../src/ledger/store";
import { closeProxy, createProxy } from "../src/proxy";
import { listen, stop } from "./fixtures/upstream";

test("HTTP upgrade streams preserve opaque bytes", async () => {
  const upstream = createServer();
  upstream.on("upgrade", (_request, socket, head) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n",
    );
    socket.write(head);
    socket.pipe(socket);
  });
  const upstreamPort = await listen(upstream);
  const ledger = new Ledger(":memory:");
  const proxy = createProxy({ ledger, config: parseConfig() });
  const port = await listen(proxy);
  try {
    const payload = Buffer.from([0, 255, 34, 13, 10, 128]);
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: `http://127.0.0.1:${upstreamPort}/stream`,
        headers: { Connection: "Upgrade", Upgrade: "fixture" },
      });
      req.on("error", reject);
      req.on("upgrade", (response, socket, head) => {
        expect(response.statusCode).toBe(101);
        const chunks: Buffer[] = [head];
        socket.setTimeout(3000, () => socket.destroy(new Error("upgrade timeout")));
        socket.on("error", reject);
        socket.on("data", (chunk: unknown) => {
          chunks.push(z.instanceof(Buffer).parse(chunk));
          if (Buffer.concat(chunks).length >= payload.length) {
            socket.destroy();
            resolve(Buffer.concat(chunks));
          }
        });
        socket.write(payload);
      });
      req.end();
    });
    expect(bytes).toEqual(payload);
    expect(ledger.diagnostics()[0]?.message).toContain("upgrade");
  } finally {
    await closeProxy(proxy);
    await stop(upstream);
    ledger.close();
  }
});

test("declined HTTP upgrades preserve response bytes and content headers", async () => {
  const upstream = createServer();
  upstream.on("upgrade", (_request, socket) =>
    socket.end(
      "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nConnection: close\r\n\r\ndenied",
    ),
  );
  const upstreamPort = await listen(upstream);
  const ledger = new Ledger(":memory:");
  const proxy = createProxy({ ledger, config: parseConfig() });
  const port = await listen(proxy);
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: `http://127.0.0.1:${upstreamPort}/stream`,
          headers: { Connection: "Upgrade", Upgrade: "fixture" },
        },
        (response) => {
          expect(response.statusCode).toBe(403);
          expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
          const chunks: Buffer[] = [];
          response.on("data", (chunk: unknown) => chunks.push(z.instanceof(Buffer).parse(chunk)));
          response.on("end", () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("denied");
  } finally {
    await closeProxy(proxy);
    await stop(upstream);
    ledger.close();
  }
});
