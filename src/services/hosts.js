// Tells whether a host name or address points inside this machine or network (loopback, private, link-local...).
// Used so the mailer and IndexNow never talk to, or advertise, internal addresses by accident.
import net from "node:net";

function privateV4(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) || // documentation ranges
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast and reserved
  );
}

// An IPv6 address as eight 16-bit numbers (the URL parser has already put it in its short lower-case form), or null.
function groupsOf(ip) {
  let x = ip.toLowerCase().split("%")[0];
  const dotted = x.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const p = dotted[1].split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    x = x.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = x.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < (halves.length === 2 ? 1 : 0)) return null;
  const all = [...left, ...Array(fill).fill("0"), ...right];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}
const v4Of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function privateV6(ip) {
  const g = groupsOf(ip);
  if (!g) return true; // can't be read: not a public address
  const zeros = (n) => g.slice(0, n).every((v) => v === 0);
  if (zeros(6)) return privateV4(v4Of(g[6], g[7])); // ::, ::1 and the old IPv4-compatible form ::a.b.c.d
  if (zeros(5) && g[5] === 0xffff) return privateV4(v4Of(g[6], g[7])); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).every((v) => v === 0) ? privateV4(v4Of(g[6], g[7])) : true; // NAT64; its local-use block is never public
  if (g[0] === 0x2002) return privateV4(v4Of(g[1], g[2])); // 6to4: the address of the gateway is inside it
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo tunnels
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  const first = g[0];
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00; // unique-local, link-local, site-local, multicast
}

// host: "example.com", "10.0.0.5", "[::1]", "localhost:4100". Anything that can't be read as a public name counts as private.
export function isPrivateHost(host) {
  let h = String(host ?? "").trim().toLowerCase();
  if (!h) return true;
  h = h.replace(/\.+(?=:\d+$|$)/, ""); // "example.com.." and "127.0.0.1.." mean the same as without the dots
  if (net.isIPv6(h)) h = `[${h}]`;
  try {
    // The URL parser also turns odd forms (2130706433, 0x7f.1, 127.1) into plain dotted addresses.
    h = new URL(`http://${h}`).hostname;
  } catch {
    return true;
  }
  h = h.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (net.isIPv4(h)) return privateV4(h);
  if (net.isIPv6(h)) return privateV6(h);
  if (!h.includes(".")) return true; // "localhost", "intranet", "nas"
  return /\.(localhost|local|internal|intranet|lan|home|corp|private|home\.arpa)$/.test(h);
}
