import { connect, createServer, type Socket } from "node:net";
import { Writable } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { parseConfig } from "../src/config";
import { Ledger } from "../src/ledger/store";
import { listen } from "./fixtures/upstream";

const diagnosticMessage =
  "Encrypted CONNECT tunnel forwarded without payment visibility. Use the SDK or explicit upstream mode to meter HTTPS.";
const payload = Buffer.from([0, 255, 128, 13, 10, 0, 42, 1]);

beforeEach(() => {
  // A fresh module gives each test its own first CONNECT, independent of other suites.
  vi.resetModules();
});

afterEach(() => vi.restoreAllMocks());

async function withTunnels(
  run: (ports: number[], ledgers: Ledger[], address: string) => Promise<void>,
): Promise<void> {
  const { createProxy, closeProxy } = await import("../src/proxy");
  const connections = new Set<Socket>();
  const echo = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    echo.once("error", reject);
    echo.listen(0, "127.0.0.1", () => {
      echo.off("error", reject);
      resolve();
    });
  });
  const address = `127.0.0.1:${z.object({ port: z.number() }).parse(echo.address()).port}`;
  const ledgers = [new Ledger(":memory:"), new Ledger(":memory:")];
  const proxies = ledgers.map((ledger) => createProxy({ ledger, config: parseConfig() }));
  try {
    const ports = await Promise.all(proxies.map(listen));
    await run(ports, ledgers, address);
  } finally {
    await Promise.all(proxies.map(closeProxy));
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      echo.close((error) => (error ? reject(error) : resolve())),
    );
    for (const ledger of ledgers) ledger.close();
  }
}

function tunnel(port: number, address: string, body = payload): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = connect(port, "127.0.0.1", () => {
      client.write(
        Buffer.concat([
          Buffer.from(`CONNECT ${address} HTTP/1.1\r\nHost: ${address}\r\n\r\n`),
          body,
        ]),
      );
    });
    const chunks: Buffer[] = [];
    let complete = false;
    client.setTimeout(3000, () => client.destroy(new Error("CONNECT timed out")));
    client.on("error", reject);
    client.on("close", () => {
      if (!complete) reject(new Error("CONNECT closed without a complete response"));
    });
    client.on("data", (chunk: unknown) => {
      chunks.push(z.instanceof(Buffer).parse(chunk));
      const response = Buffer.concat(chunks);
      const end = response.indexOf("\r\n\r\n");
      if (end === -1) return;
      const successful = response.subarray(0, end).toString().startsWith("HTTP/1.1 200 ");
      if (!successful || response.length - end - 4 >= body.length) {
        complete = true;
        client.destroy();
        resolve(response);
      }
    });
  });
}

function successfulReply(): Buffer {
  return Buffer.concat([Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"), payload]);
}

test("CONNECT warns once across proxy instances and keeps every diagnostic and tunnel byte", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await withTunnels(async (ports, ledgers, address) => {
    const [firstPort, secondPort] = z.tuple([z.number(), z.number()]).parse(ports);
    expect(await tunnel(firstPort, "invalid", Buffer.alloc(0))).toEqual(
      Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n"),
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(ledgers.flatMap((ledger) => ledger.diagnostics())).toEqual([]);

    expect(await Promise.all([tunnel(firstPort, address), tunnel(secondPort, address)])).toEqual([
      successfulReply(),
      successfulReply(),
    ]);
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([`${diagnosticMessage}\n`]);
    expect(await tunnel(firstPort, address)).toEqual(successfulReply());
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([`${diagnosticMessage}\n`]);
    expect(stdout).not.toHaveBeenCalled();
    expect(ledgers.map((ledger) => ledger.diagnostics().length)).toEqual([2, 1]);
    for (const ledger of ledgers) {
      expect(ledger.events()).toEqual([]);
      for (const diagnostic of ledger.diagnostics()) {
        expect(diagnostic).toEqual(
          expect.objectContaining({
            code: "tls_unmetered",
            resource: address,
            message: diagnosticMessage,
          }),
        );
      }
    }
  });
});

test("a broken stderr cannot reject a valid CONNECT or repeatedly attempt the notice", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
    throw new Error("stderr unavailable");
  });
  await withTunnels(async (ports, ledgers, address) => {
    for (const port of ports) expect(await tunnel(port, address)).toEqual(successfulReply());
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([`${diagnosticMessage}\n`]);
    expect(ledgers.map((ledger) => ledger.diagnostics().length)).toEqual([1, 1]);
  });
});

test("an asynchronous stderr EPIPE is handled while CONNECT continues", async () => {
  let unhandled: unknown;
  const brokenPipe = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
    },
  });
  const failed = new Promise<Error>((resolve) => {
    brokenPipe.once("error", (error) => {
      try {
        process.stderr.emit("error", error);
      } catch (failure) {
        unhandled = failure;
      }
      resolve(error);
    });
  });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk, encoding, callback) => {
      if (typeof encoding === "function") return brokenPipe.write(chunk, encoding);
      if (encoding === undefined) return brokenPipe.write(chunk, callback);
      return brokenPipe.write(chunk, encoding, callback);
    });
  await withTunnels(async (ports, ledgers, address) => {
    expect(process.stderr.listenerCount("error")).toBe(0);
    for (const port of ports) expect(await tunnel(port, address)).toEqual(successfulReply());
    expect(await failed).toMatchObject({ code: "EPIPE" });
    expect(unhandled).toBeUndefined();
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([`${diagnosticMessage}\n`]);
    expect(ledgers.map((ledger) => ledger.diagnostics().length)).toEqual([1, 1]);
  });
});

test("a valid CONNECT to an unavailable upstream still closes and consumes the first notice", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await withTunnels(async (ports, ledgers, address) => {
    const unavailable = createServer();
    await new Promise<void>((resolve, reject) => {
      unavailable.once("error", reject);
      unavailable.listen(0, "127.0.0.1", () => {
        unavailable.off("error", reject);
        resolve();
      });
    });
    const unusedAddress = `127.0.0.1:${z.object({ port: z.number() }).parse(unavailable.address()).port}`;
    await new Promise<void>((resolve, reject) =>
      unavailable.close((error) => (error ? reject(error) : resolve())),
    );
    const [firstPort, secondPort] = z.tuple([z.number(), z.number()]).parse(ports);
    await expect(tunnel(firstPort, unusedAddress)).rejects.toThrow(
      "CONNECT closed without a complete response",
    );
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([`${diagnosticMessage}\n`]);
    expect(await tunnel(secondPort, address)).toEqual(successfulReply());
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([`${diagnosticMessage}\n`]);
    expect(
      ledgers.flatMap((ledger) => ledger.diagnostics().map((entry) => entry.resource)),
    ).toEqual([unusedAddress, address]);
  });
});
