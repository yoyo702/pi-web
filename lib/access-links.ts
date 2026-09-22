import type { NetworkInterfaceInfo } from "node:os";

export type AccessNetworkKind = "tailscale" | "lan" | "network";

export interface AccessAddress {
  id: string;
  interfaceName: string;
  address: string;
  family: "IPv4" | "IPv6";
  kind: AccessNetworkKind;
  label: string;
  origin: string;
  reachable: boolean;
}

export interface AccessInfo {
  protocol: "http" | "https";
  port: number;
  listenHost: string;
  passwordRequired: boolean;
  addresses: AccessAddress[];
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

export function classifyAccessAddress(address: string): AccessNetworkKind | null {
  if (address.toLowerCase().startsWith("fd7a:115c:a1e0:")) return "tailscale";
  const octets = ipv4Octets(address);
  if (!octets) return null;
  const [first, second] = octets;
  if (first === 100 && second >= 64 && second <= 127) return "tailscale";
  if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) return "lan";
  if (first === 127 || (first === 169 && second === 254) || first === 0 || first >= 224) return null;
  return "network";
}

export function formatAccessOrigin(protocol: "http" | "https", address: string, port: number): string {
  const host = address.includes(":") ? `[${address}]` : address;
  const defaultPort = (protocol === "http" && port === 80) || (protocol === "https" && port === 443);
  return `${protocol}://${host}${defaultPort ? "" : `:${port}`}`;
}

export function canReachAddress(listenHost: string, address: string): boolean {
  const normalizedHost = listenHost.replace(/^\[|\]$/g, "").toLowerCase();
  return normalizedHost === "0.0.0.0"
    || normalizedHost === "::"
    || normalizedHost === address.toLowerCase();
}

export function collectAccessAddresses(
  networks: NodeJS.Dict<NetworkInterfaceInfo[]>,
  options: { protocol: "http" | "https"; port: number; listenHost: string },
): AccessAddress[] {
  const seen = new Set<string>();
  const addresses: AccessAddress[] = [];

  for (const [interfaceName, entries] of Object.entries(networks)) {
    for (const entry of entries ?? []) {
      // Prefer the stable, broadly scannable IPv4 address. Tailscale assigns an
      // IPv4 address even when its IPv6 address is also present, and the local
      // mkcert helper currently provisions interface IPv4 SANs.
      if (entry.internal || entry.family !== "IPv4" || seen.has(entry.address)) continue;
      const kind = classifyAccessAddress(entry.address);
      if (!kind) continue;
      seen.add(entry.address);
      const kindLabel = kind === "tailscale" ? "Tailscale" : kind === "lan" ? "Local network" : "Network";
      addresses.push({
        id: `${interfaceName}:${entry.address}`,
        interfaceName,
        address: entry.address,
        family: "IPv4",
        kind,
        label: `${kindLabel} · ${interfaceName}`,
        origin: formatAccessOrigin(options.protocol, entry.address, options.port),
        reachable: canReachAddress(options.listenHost, entry.address),
      });
    }
  }

  const kindOrder: Record<AccessNetworkKind, number> = { tailscale: 0, lan: 1, network: 2 };
  return addresses.sort((left, right) => {
    const kindDifference = kindOrder[left.kind] - kindOrder[right.kind];
    if (kindDifference !== 0) return kindDifference;
    if (left.family !== right.family) return left.family === "IPv4" ? -1 : 1;
    return left.address.localeCompare(right.address, undefined, { numeric: true });
  });
}
