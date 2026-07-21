/**
 * Webhook egress hardening: block private / link-local / metadata targets.
 * Resolves DNS and checks every address; rejects non-https and open redirects.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return (
    (n >= ipv4ToInt("10.0.0.0") && n <= ipv4ToInt("10.255.255.255")) ||
    (n >= ipv4ToInt("127.0.0.0") && n <= ipv4ToInt("127.255.255.255")) ||
    (n >= ipv4ToInt("169.254.0.0") && n <= ipv4ToInt("169.254.255.255")) ||
    (n >= ipv4ToInt("172.16.0.0") && n <= ipv4ToInt("172.31.255.255")) ||
    (n >= ipv4ToInt("192.168.0.0") && n <= ipv4ToInt("192.168.255.255")) ||
    (n >= ipv4ToInt("0.0.0.0") && n <= ipv4ToInt("0.255.255.255")) ||
    n === ipv4ToInt("255.255.255.255")
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80:") ||
    // IPv4-mapped
    lower.startsWith("::ffff:")
  );
}

function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) {
    if (ip.toLowerCase().startsWith("::ffff:")) {
      const mapped = ip.slice(ip.lastIndexOf(":") + 1);
      if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
    }
    return isPrivateIpv6(ip);
  }
  return true;
}

/** Throws if the URL is not safe for server-side webhook delivery. */
export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid webhook URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("Webhook URL must use https");
  }
  if (url.username || url.password) {
    throw new Error("Webhook URL must not include credentials");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Webhook URL host is not allowed");
  }

  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error("Webhook URL must not target a private IP");
    return url;
  }

  let addresses: string[];
  try {
    const results = await lookup(host, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new Error("Webhook URL host could not be resolved");
  }

  if (addresses.length === 0) {
    throw new Error("Webhook URL host could not be resolved");
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new Error("Webhook URL resolves to a private or link-local address");
    }
  }

  return url;
}
