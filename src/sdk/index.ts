import { z } from "zod";
import { configPatchSchema, parseConfig } from "../config";
import { loadConfig } from "../config/io";
import { Meter } from "../core";
import { Ledger } from "../ledger/store";
import { httpUrlSchema, labelSchema } from "../model";

const headerInputSchema = z.union([
  z.instanceof(Headers),
  z.record(z.string(), z.string()),
  z.array(z.tuple([z.string(), z.string()])),
]);
const initSchema = z.looseObject({
  method: z.string().optional(),
  headers: headerInputSchema.optional(),
  signal: z.instanceof(AbortSignal).nullable().optional(),
});
const sdkLabel = labelSchema.refine(
  (value) => !/[\r\n\0]/.test(value),
  "Attribution must fit an HTTP header",
);
const optionsSchema = z.strictObject({
  ledger: z.instanceof(Ledger).optional(),
  config: configPatchSchema.optional(),
  db: z.string().min(1).optional(),
  taskId: sdkLabel.optional(),
  agentId: sdkLabel.optional(),
});
export type MeterOptions = z.input<typeof optionsSchema>;
export type MeteredFetch = typeof globalThis.fetch & { close(): void; readonly ledger: Ledger };

/** A v1 challenge tap is bounded in bytes and time; the original stream is returned. */
async function challengeBody(response: Response): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) return new Uint8Array();
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async (): Promise<Uint8Array<ArrayBuffer> | undefined> => {
    const parts: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return Buffer.concat(parts);
      }
      const bytes = z.instanceof(Uint8Array).parse(chunk.value);
      length += bytes.byteLength;
      if (length > 65_536) return undefined;
      parts.push(bytes);
    }
  };
  try {
    return await Promise.race([
      read(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 100);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!done) void reader.cancel().catch(() => {});
  }
}

/** Place inside the payment wrapper: wrapFetchWithPayment(withMeter(fetch, opts), client). */
export function withMeter(
  fetchImpl: typeof globalThis.fetch,
  input: MeterOptions = {},
): MeteredFetch {
  const transport = z
    .custom<typeof globalThis.fetch>((value) => typeof value === "function")
    .parse(fetchImpl);
  const options = optionsSchema.parse(input);
  const overrides = { ...options.config, ...(options.db ? { db: options.db } : {}) };
  const config = options.ledger ? parseConfig(overrides) : loadConfig(overrides);
  const ledger = options.ledger ?? new Ledger(config.db);
  const meter = new Meter(ledger, config);
  let closed = false;
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    if (closed) return transport(input, init);
    let url: string;
    let method: string;
    let headers: Headers;
    let forwarded = init;
    try {
      const target = z.union([z.string(), z.instanceof(URL), z.instanceof(Request)]).parse(input);
      const options = initSchema.optional().parse(init);
      url = httpUrlSchema.parse(target instanceof Request ? target.url : target.toString());
      method = options?.method ?? (target instanceof Request ? target.method : "GET");
      headers = new Headers(
        options?.headers ?? (target instanceof Request ? target.headers : undefined),
      );
      const signal = options?.signal ?? (target instanceof Request ? target.signal : undefined);
      if (signal?.aborted) return transport(input, init);
    } catch {
      meter.diagnose(
        "parse_failed",
        "sdk",
        "Unsupported fetch input; passed directly to the supplied transport.",
      );
      return transport(input, init);
    }
    if (options.taskId) headers.set("Taximeter-Task", options.taskId);
    if (options.agentId) headers.set("Taximeter-Agent", options.agentId);
    if (options.taskId || options.agentId) forwarded = { ...init, headers };
    const request = { url, method, headers: Object.fromEntries(headers) };
    const intake = meter.begin(request);
    if (intake.body)
      return new Response(JSON.stringify(intake.body), {
        status: 402,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    let response: Response;
    try {
      response = await transport(input, forwarded);
    } catch (error) {
      meter.complete(intake);
      throw error;
    }
    const responseHeaders = Object.fromEntries(response.headers);
    const reply = { status: response.status, headers: responseHeaders };
    meter.complete(intake, reply);
    if (response.status === 402) {
      try {
        const body = response.headers.has("payment-required")
          ? undefined
          : await challengeBody(response);
        // Fetch has already decoded content encoding; only the clone is inspected.
        const inspectionHeaders = { ...responseHeaders };
        delete inspectionHeaders["content-encoding"];
        meter.observe(request, { ...reply, headers: inspectionHeaders, body });
      } catch {
        meter.diagnose(
          "parse_failed",
          url,
          "Could not inspect response clone; original response preserved.",
        );
      }
    }
    return response;
  };
  return Object.assign(wrapped, {
    ledger,
    close() {
      if (closed) return;
      closed = true;
      if (!options.ledger) ledger.close();
    },
  });
}
