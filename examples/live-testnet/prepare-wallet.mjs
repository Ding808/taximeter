import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { CheckFailure, ensure, NETWORK, publicWallets, ROOT } from "./balance.mjs";

try {
  const directory = join(ROOT, "secrets");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensure(!lstatSync(directory).isSymbolicLink(), "Refusing a linked secrets directory.");
  const addresses = {};
  for (const role of ["payer", "recipient"]) {
    const path = join(directory, `${role}.key`);
    if (!existsSync(path)) writeFileSync(path, generatePrivateKey(), { flag: "wx", mode: 0o600 });
    ensure(
      lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
      "Expected a regular local key file.",
    );
    const key = z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .parse(readFileSync(path, "utf8").trim());
    addresses[role] = privateKeyToAccount(key).address;
  }
  const details = { network: NETWORK, testnetOnly: true, ...addresses };
  const publicPath = join(ROOT, "wallet-addresses.json");
  if (existsSync(publicPath)) {
    const existing = publicWallets();
    ensure(
      existing.payer === details.payer && existing.recipient === details.recipient,
      "Existing public wallet details do not match the local keys; nothing was overwritten.",
    );
  } else {
    writeFileSync(publicPath, `${JSON.stringify(details, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  console.log("Disposable Base Sepolia test wallets are ready. Existing keys were preserved.");
  console.log(JSON.stringify(details, null, 2));
  console.log("Only public addresses are displayed. Fund the payer using Circle's testnet faucet.");
} catch (error) {
  console.error(
    error instanceof CheckFailure
      ? error.message
      : "Wallet preparation failed; secret details suppressed.",
  );
  process.exitCode = 1;
}
