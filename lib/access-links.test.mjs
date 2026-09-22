import assert from "node:assert/strict";
import test from "node:test";
import {
  canReachAddress,
  classifyAccessAddress,
  collectAccessAddresses,
  formatAccessOrigin,
} from "./access-links.ts";

test("classifies Tailscale and private LAN addresses", () => {
  assert.equal(classifyAccessAddress("100.104.231.51"), "tailscale");
  assert.equal(classifyAccessAddress("fd7a:115c:a1e0::1234"), "tailscale");
  assert.equal(classifyAccessAddress("192.168.100.232"), "lan");
  assert.equal(classifyAccessAddress("172.31.0.2"), "lan");
  assert.equal(classifyAccessAddress("8.8.8.8"), "network");
  assert.equal(classifyAccessAddress("127.0.0.1"), null);
  assert.equal(classifyAccessAddress("fe80::1"), null);
});

test("formats IPv4, IPv6, and default-port origins", () => {
  assert.equal(formatAccessOrigin("https", "100.104.231.51", 30141), "https://100.104.231.51:30141");
  assert.equal(formatAccessOrigin("https", "fd7a:115c:a1e0::1234", 443), "https://[fd7a:115c:a1e0::1234]");
  assert.equal(formatAccessOrigin("http", "192.168.1.2", 80), "http://192.168.1.2");
});

test("marks network addresses reachable only for matching or wildcard binds", () => {
  assert.equal(canReachAddress("0.0.0.0", "192.168.1.2"), true);
  assert.equal(canReachAddress("::", "fd7a:115c:a1e0::1234"), true);
  assert.equal(canReachAddress("192.168.1.2", "192.168.1.2"), true);
  assert.equal(canReachAddress("127.0.0.1", "192.168.1.2"), false);
});

test("collects, deduplicates, and sorts Tailscale before LAN", () => {
  const addresses = collectAccessAddresses({
    en0: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }],
    utun4: [{ address: "100.70.0.2", netmask: "255.192.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.70.0.2/10" }],
    duplicate: [{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "192.168.1.20/24" }],
    ipv6: [{ address: "fd7a:115c:a1e0::1234", netmask: "ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: "fd7a:115c:a1e0::1234/48", scopeid: 0 }],
  }, { protocol: "https", port: 30141, listenHost: "0.0.0.0" });

  assert.deepEqual(addresses.map((entry) => entry.kind), ["tailscale", "lan"]);
  assert.equal(addresses[0].reachable, true);
  assert.equal(addresses[1].origin, "https://192.168.1.20:30141");
});
