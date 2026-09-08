import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { TaximeterConfig } from "../config";
import { toCsv, toInvoice, toJson } from "../export";
import type { Ledger } from "../ledger/store";
import { dashboardState } from "./state";

const querySchema = z.strictObject({ format: z.enum(["csv", "json", "invoice"]).optional() });
const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function uiDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return (
    [resolve(here, "ui"), resolve(here, "../ui"), resolve(here, "../../dist/ui")].find((path) =>
      existsSync(resolve(path, "index.html")),
    ) ?? resolve(here, "ui")
  );
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

export function createDashboard(options: {
  ledger: Ledger;
  config: TaximeterConfig;
  uiRoot?: string;
}) {
  const root = resolve(options.uiRoot ?? uiDirectory());
  return createServer((request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      const input = z
        .object({
          method: z.string(),
          url: z.string(),
          headers: z.object({
            host: z.string(),
            origin: z.string().optional(),
            "sec-fetch-site": z.string().optional(),
          }),
        })
        .parse(request);
      const localPort = request.socket.localPort;
      const allowed = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
      if (
        !allowed.includes(input.headers.host.toLowerCase()) ||
        (input.headers.origin &&
          !allowed.map((host) => `http://${host}`).includes(input.headers.origin)) ||
        input.headers["sec-fetch-site"] === "cross-site"
      ) {
        json(response, 403, { error: "local_origin_required" });
        return;
      }
      if (!["GET", "HEAD"].includes(input.method)) {
        response.setHeader("Allow", "GET, HEAD");
        json(response, 405, { error: "read_only" });
        return;
      }
      const url = new URL(input.url, `http://${input.headers.host}`);
      if (url.origin !== `http://${input.headers.host}`) {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      const entries = [...url.searchParams];
      if (new Set(entries.map(([key]) => key)).size !== entries.length) {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      const query = querySchema.parse(Object.fromEntries(entries));
      if (url.pathname === "/api/summary") {
        json(response, 200, dashboardState(options.ledger, options.config));
        return;
      }
      if (url.pathname === "/api/export") {
        const format = query.format ?? "json";
        const events = options.ledger.view();
        const body =
          format === "csv"
            ? toCsv(events)
            : format === "invoice"
              ? toInvoice(events)
              : toJson(events);
        response.writeHead(200, {
          "Content-Type":
            format === "csv"
              ? "text/csv; charset=utf-8"
              : format === "invoice"
                ? "text/html; charset=utf-8"
                : "application/json",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="taximeter.${format === "invoice" ? "html" : format}"`,
        });
        response.end(body);
        return;
      }
      const decoded = decodeURIComponent(url.pathname);
      const path = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
      if (!path.startsWith(`${root}${sep}`)) {
        json(response, 403, { error: "forbidden" });
        return;
      }
      if (!existsSync(path) || !statSync(path).isFile() || !types[extname(path)]) {
        if (url.pathname === "/" && !existsSync(resolve(root, "index.html"))) {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end(
            "<!doctype html><title>Taximeter</title><h1>Taximeter</h1><p>The local ledger is ready. Contributors: run npm run build to build the dashboard.</p>",
          );
          return;
        }
        json(response, 404, { error: "not_found" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": types[extname(path)],
        "Cache-Control": path.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      });
      response.end(readFileSync(path));
    } catch {
      json(response, 400, { error: "invalid_request" });
    }
  });
}
