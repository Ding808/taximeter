import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { parseConfig, type TaximeterConfig } from "../config";
import { Meter } from "../core";
import type { Ledger } from "../ledger/store";
import { httpUrlSchema } from "../model";
import type { WireRequest } from "../rails/types";

const incomingHeadersSchema = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string()), z.undefined()]),
);
const sockets = new WeakMap<Server, Set<Socket>>();

export function normalizedHeaders(input: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(incomingHeadersSchema.parse(input))) {
    if (value !== undefined)
      result[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function forwardingHeaders(message: IncomingMessage, host?: string, upgrade = false): string[] {
  const headers = normalizedHeaders(message.headers);
  const connectionTokens = (headers.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  const remove = new Set([
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    ...(!upgrade ? ["connection", "upgrade", ...connectionTokens] : []),
    ...(host ? ["host"] : []),
  ]);
  const result: string[] = [];
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    const name = message.rawHeaders[i];
    const value = message.rawHeaders[i + 1];
    if (name && value !== undefined && !remove.has(name.toLowerCase())) result.push(name, value);
  }
  if (host) result.push("Host", host);
  return result;
}

function targetFor(request: IncomingMessage, config: TaximeterConfig): URL {
  const path = z.string().min(1).parse(request.url);
  return new URL(
    httpUrlSchema.parse(
      /^https?:\/\//i.test(path)
        ? path
        : config.upstream
          ? new URL(path, config.upstream).href
          : "",
    ),
  );
}
function wire(request: IncomingMessage, target: URL): WireRequest {
  return {
    url: target.href,
    method: z.string().parse(request.method),
    headers: normalizedHeaders(request.headers),
  };
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createProxy(options: { ledger: Ledger; config: TaximeterConfig }): Server {
  const config = parseConfig(options.config);
  const meter = new Meter(options.ledger, config);
  const server = createServer({ requestTimeout: 0 }, (request, response) => {
    let target: URL;
    try {
      target = targetFor(request, config);
    } catch {
      json(response, 400, {
        error: "upstream_required",
        hint: "Use an HTTP forward-proxy client or start with --upstream https://your-api.example.",
      });
      request.resume();
      return;
    }
    const input = wire(request, target);
    const intake = meter.begin(input);
    if (intake.body) {
      json(response, 402, intake.body);
      request.resume();
      return;
    }
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = transport(
      target,
      { method: request.method, headers: forwardingHeaders(request, target.host) },
      (reply) => {
        const headers = normalizedHeaders(reply.headers);
        const status = reply.statusCode ?? 502;
        const upstream = { status, headers };
        meter.complete(intake, upstream);
        const needsBody = status === 402 && !headers["payment-required"];
        const chunks: Buffer[] = [];
        let length = 0;
        if (status === 402 && !needsBody) meter.observe(input, upstream);
        if (needsBody)
          reply.on("data", (chunk: unknown) => {
            const bytes = z.instanceof(Buffer).parse(chunk);
            length += bytes.length;
            if (length <= 65_536) chunks.push(bytes);
            else chunks.length = 0;
          });
        response.writeHead(status, reply.statusMessage, forwardingHeaders(reply));
        reply.on("end", () => {
          if (needsBody)
            meter.observe(input, {
              ...upstream,
              body: length <= 65_536 ? Buffer.concat(chunks) : undefined,
            });
          response.addTrailers(reply.trailers);
          response.end();
        });
        reply.on("error", () => response.destroy());
        reply.on("aborted", () => response.destroy());
        reply.pipe(response, { end: false });
      },
    );
    outgoing.on("error", () => {
      meter.complete(intake);
      if (!response.headersSent) json(response, 502, { error: "upstream_unavailable" });
      else response.destroy();
    });
    request.on("aborted", () => outgoing.destroy());
    request.on("error", () => outgoing.destroy());
    request.on("end", () => outgoing.addTrailers(request.trailers));
    response.on("close", () => {
      if (!response.writableEnded) outgoing.destroy();
    });
    request.pipe(outgoing);
  });

  const connections = new Set<Socket>();
  sockets.set(server, connections);
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  server.on("connect", (request, client, head) => {
    try {
      const address = z
        .string()
        .regex(/^(?:\[[0-9a-fA-F:]+\]|[^\s/:?#@]+):[0-9]+$/)
        .parse(request.url);
      const target = new URL(`http://${address}`);
      const port = z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .parse(target.port || "80");
      const host = target.hostname.replace(/^\[|\]$/g, "");
      meter.diagnose(
        "tls_unmetered",
        address,
        "Encrypted CONNECT tunnel forwarded without payment visibility. Use the SDK or explicit upstream mode to meter HTTPS.",
      );
      const upstream = connect(port, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });

  server.on("upgrade", (request, client, head) => {
    try {
      const target = targetFor(request, config);
      const input = wire(request, target);
      const intake = meter.begin(input);
      if (intake.body) {
        client.end(
          `HTTP/1.1 402 Payment Required\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify(intake.body)}`,
        );
        return;
      }
      meter.diagnose(
        "parse_failed",
        target.href,
        "HTTP upgrade forwarded; subsequent stream frames are unmetered.",
      );
      const outgoing = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
        method: request.method,
        headers: forwardingHeaders(request, target.host, true),
      });
      const handshake = (reply: IncomingMessage, stream: Duplex, responseHead: Buffer) => {
        meter.complete(intake, {
          status: reply.statusCode ?? 101,
          headers: normalizedHeaders(reply.headers),
        });
        const headers = forwardingHeaders(reply, undefined, true);
        let text = `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n`;
        for (let i = 0; i < headers.length; i += 2) text += `${headers[i]}: ${headers[i + 1]}\r\n`;
        client.write(`${text}\r\n`);
        client.write(responseHead);
        stream.write(head);
        stream.pipe(client);
        client.pipe(stream);
        stream.on("error", () => client.destroy());
        client.on("error", () => stream.destroy());
        client.on("close", () => stream.destroy());
        stream.on("close", () => client.destroy());
      };
      outgoing.on("upgrade", handshake);
      outgoing.on("response", (reply) => {
        meter.complete(intake, {
          status: reply.statusCode ?? 502,
          headers: normalizedHeaders(reply.headers),
        });
        const response = new ServerResponse(request);
        if (!(client instanceof Socket)) {
          client.destroy();
          return;
        }
        response.assignSocket(client);
        response.writeHead(reply.statusCode ?? 502, reply.statusMessage, forwardingHeaders(reply));
        reply.on("end", () => {
          response.addTrailers(reply.trailers);
          response.end();
        });
        reply.pipe(response, { end: false });
      });
      outgoing.on("error", () => {
        meter.complete(intake);
        client.destroy();
      });
      client.on("close", () => outgoing.destroy());
      outgoing.end();
    } catch {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
  });
  return server;
}

export async function closeProxy(server: Server): Promise<void> {
  for (const socket of sockets.get(server) ?? []) socket.destroy();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
