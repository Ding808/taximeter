import { v7 } from "uuid";
import { type PaymentEvent, paymentEventSchema } from "../src/model";

export function event(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  const id = v7();
  return paymentEventSchema.parse({
    id,
    ts: "2026-09-08T12:00:00.000Z",
    rail: "x402",
    status: "observed",
    amount: "7",
    decimals: 6,
    decimalsKnown: true,
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    assetSymbol: "USDC",
    network: "eip155:8453",
    payTo: "0x209693bc6afc0c5328ba36faf03c514ef312287c",
    payer: "0x857b06519e91e3a54538791bdbb0e22373e36b66",
    resource: "https://api.example.test/data",
    host: "api.example.test",
    taskId: "task-a",
    agentId: "agent-a",
    raw: "{}",
    paymentKey: id,
    ...overrides,
  });
}
