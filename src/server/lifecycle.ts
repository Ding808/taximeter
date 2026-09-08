import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { TaximeterConfig } from "../config";
import { expandPath } from "../config/io";
import { Ledger } from "../ledger/store";
import { closeProxy, createProxy } from "../proxy";

export async function listenLocal(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return z.object({ port: z.number() }).parse(server.address()).port;
}

export function assertStopped(db: string): void {
  if (db === ":memory:") return;
  const path = `${db}.lock`;
  if (!existsSync(path)) return;
  const lock = z
    .object({ pid: z.number().int().positive() })
    .parse(JSON.parse(readFileSync(path, "utf8")));
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (z.object({ code: z.literal("ESRCH") }).safeParse(error).success) {
      unlinkSync(path);
      return;
    }
    throw new Error("Cannot determine whether the ledger is in use.");
  }
  throw new Error("Taximeter is already running for this ledger. Stop it first.");
}

export function acquireLock(db: string): () => void {
  if (db === ":memory:") return () => {};
  assertStopped(db);
  const lock = `${db}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  return () => unlinkSync(lock);
}

export async function startServices(input: TaximeterConfig) {
  const config = { ...input, db: expandPath(input.db) };
  assertStopped(config.db);
  const ledger = new Ledger(config.db);
  let release: () => void;
  try {
    release = acquireLock(config.db);
  } catch (error) {
    ledger.close();
    throw error;
  }
  const proxy = createProxy({ ledger, config });
  const dashboard = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
    });
    response.end(
      "<!doctype html><title>Taximeter</title><h1>Taximeter is running</h1><p>Use taximeter report to inspect the local ledger.</p>",
    );
  });
  try {
    const proxyPort = await listenLocal(proxy, config.ports.proxy);
    const dashboardPort = await listenLocal(dashboard, config.ports.dashboard);
    let closed = false;
    return {
      ledger,
      proxy,
      dashboard,
      proxyPort,
      dashboardPort,
      async close() {
        if (closed) return;
        closed = true;
        dashboard.closeAllConnections();
        await Promise.all([
          closeProxy(proxy),
          new Promise<void>((resolve) => dashboard.close(() => resolve())),
        ]);
        ledger.close();
        release();
      },
    };
  } catch (error) {
    if (proxy.listening) await closeProxy(proxy);
    if (dashboard.listening) dashboard.close();
    ledger.close();
    release();
    throw error;
  }
}
