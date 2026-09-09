/** Offline metadata from the x402 default-asset table, verified 2026-09-08. */
const usdc: Readonly<Record<string, string>> = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

export function assetMetadata(network: string, asset: string) {
  return usdc[network] === asset.toLowerCase()
    ? { decimals: 6, decimalsKnown: true, assetSymbol: "USDC" }
    : { decimals: 0, decimalsKnown: false };
}

/** Enumerate the same offline registry used to recognize payment assets. */
export function knownAssets() {
  return Object.entries(usdc).map(([network, asset]) => ({
    network,
    asset,
    ...assetMetadata(network, asset),
  }));
}

export function matchesAsset(
  selector: string,
  payment: { network: string; asset: string },
): boolean {
  return (
    selector.toLowerCase() === payment.asset.toLowerCase() ||
    (selector === "USDC" && assetMetadata(payment.network, payment.asset).assetSymbol === "USDC")
  );
}
