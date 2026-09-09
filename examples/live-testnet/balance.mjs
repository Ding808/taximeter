import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { z } from "zod";

export const ROOT = fileURLToPath(new URL("./", import.meta.url));
export const NETWORK = "eip155:84532";
export const CHAIN_ID = 84532;
export const RPC = "https://sepolia.base.org";
export const FACILITATOR = "https://x402.org/facilitator";
export const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const AMOUNT = 1000n;
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const tokenAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const walletSchema = z.strictObject({
  network: z.literal(NETWORK),
  testnetOnly: z.literal(true),
  payer: addressSchema,
  recipient: addressSchema,
});
const atomic = z.bigint().nonnegative();

export class CheckFailure extends Error {}
export function ensure(condition, message) {
  if (!condition) throw new CheckFailure(message);
}
export function publicWallets() {
  const wallets = walletSchema.parse(
    JSON.parse(readFileSync(resolve(ROOT, "wallet-addresses.json"), "utf8")),
  );
  ensure(
    wallets.payer.toLowerCase() !== wallets.recipient.toLowerCase(),
    "Payer and recipient must differ.",
  );
  return wallets;
}
export function publicClient() {
  return createPublicClient({ chain: baseSepolia, transport: http(RPC, { timeout: 30000 }) });
}
export async function balances(client, wallets) {
  const [payer, recipient] = await Promise.all([
    client.readContract({
      address: ASSET,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [wallets.payer],
    }),
    client.readContract({
      address: ASSET,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [wallets.recipient],
    }),
  ]);
  return { payer: atomic.parse(payer), recipient: atomic.parse(recipient) };
}
export async function checkFunding() {
  const wallets = publicWallets();
  const client = publicClient();
  ensure(
    (await client.getChainId()) === CHAIN_ID,
    "RPC is not Base Sepolia; stopped before signing.",
  );
  const [decimals, name, version, balance] = await Promise.all([
    client.readContract({ address: ASSET, abi: tokenAbi, functionName: "decimals" }),
    client.readContract({ address: ASSET, abi: tokenAbi, functionName: "name" }),
    client.readContract({ address: ASSET, abi: tokenAbi, functionName: "version" }),
    balances(client, wallets),
  ]);
  ensure(
    decimals === 6 && name === "USDC" && version === "2",
    "Unexpected test USDC metadata; stopped before signing.",
  );
  return { wallets, client, balance, funded: balance.payer >= AMOUNT };
}
export function displayAmount(value) {
  const digits = value.toString().padStart(7, "0");
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}
export async function printFunding() {
  const funding = await checkFunding();
  console.log(
    JSON.stringify(
      {
        testnetOnly: true,
        network: NETWORK,
        chainId: CHAIN_ID,
        asset: ASSET,
        payer: funding.wallets.payer,
        recipient: funding.wallets.recipient,
        payerBalanceAtomic: funding.balance.payer.toString(),
        recipientBalanceAtomic: funding.balance.recipient.toString(),
        requiredAtomic: AMOUNT.toString(),
        funded: funding.funded,
      },
      null,
      2,
    ),
  );
  ensure(funding.funded, "At least 0.001000 test USDC is required; no payment was attempted.");
  console.log(
    "TESTNET FUNDING CHECK PASSED — public RPC reads only; no key loaded or payment attempted.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  printFunding().catch((error) => {
    console.error(
      error instanceof CheckFailure
        ? error.message
        : "Public funding check failed; details suppressed.",
    );
    process.exitCode = 1;
  });
}
