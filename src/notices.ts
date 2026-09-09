import { Console } from "node:console";
import type { BlockedBody } from "./model";

const console = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: true });
const shown = new Set<string>();

/** Shared by the proxy and SDK; terminal I/O runs after the reservation transaction. */
export function blockedNotice(body: BlockedBody): void {
  if (!body.fix || shown.has(body.reason)) return;
  shown.add(body.reason);
  try {
    console.error(
      `Taximeter blocked (${body.reason}). To change this policy: ${body.fix}. Restart taximeter after editing.`,
    );
  } catch {
    // A closed console must never change the payment decision.
  }
}
