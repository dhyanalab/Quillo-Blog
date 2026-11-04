// Social networks for author profiles and the site's social links: name, logo, the web addresses that
// belong to it, and how to turn a username into a full link ("yourbrand" -> https://www.instagram.com/yourbrand/).
import { BRAND_PATHS } from "./brand-paths.js";

export const NETWORKS = [
  { id: "website", name: "Website", hosts: [], placeholder: "https://yourwebsite.com" },
  { id: "youtube", name: "YouTube", hosts: ["youtube.com", "youtu.be"], user: (u) => `https://www.youtube.com/@${u}`, placeholder: "@channel or full link" },
  { id: "instagram", name: "Instagram", hosts: ["instagram.com"], user: (u) => `https://www.instagram.com/${u}/`, placeholder: "username or full link" },
  { id: "facebook", name: "Facebook", hosts: ["facebook.com", "fb.com", "fb.me"], user: (u) => `https://www.facebook.com/${u}`, placeholder: "page name or full link" },
  { id: "x", name: "X (Twitter)", hosts: ["x.com", "twitter.com"], user: (u) => `https://x.com/${u}`, placeholder: "username or full link" },
  { id: "linkedin", name: "LinkedIn", hosts: ["linkedin.com"], user: (u) => `https://www.linkedin.com/in/${u}`, placeholder: "profile name or full link" },
  { id: "github", name: "GitHub", hosts: ["github.com"], user: (u) => `https://github.com/${u}`, placeholder: "username or full link" },
  { id: "whatsapp", name: "WhatsApp channel", hosts: ["whatsapp.com", "wa.me"], placeholder: "https://whatsapp.com/channel/…" },
  { id: "telegram", name: "Telegram", hosts: ["t.me", "telegram.me", "telegram.org"], user: (u) => `https://t.me/${u}`, placeholder: "channel name or full link" },
  { id: "discord", name: "Discord", hosts: ["discord.gg", "discord.com"], placeholder: "https://discord.gg/…" },
  { id: "threads", name: "Threads", hosts: ["threads.net", "threads.com"], user: (u) => `https://www.threads.net/@${u}`, placeholder: "username or full link" },
  { id: "reddit", name: "Reddit", hosts: ["reddit.com"], user: (u) => `https://www.reddit.com/user/${u}`, placeholder: "username or full link" },
  { id: "medium", name: "Medium", hosts: ["medium.com"], user: (u) => `https://medium.com/@${u}`, placeholder: "username or full link" },
  { id: "hackster", name: "Hackster.io", hosts: ["hackster.io"], user: (u) => `https://www.hackster.io/${u}`, placeholder: "username or full link" },
  { id: "instructables", name: "Instructables", hosts: ["instructables.com"], user: (u) => `https://www.instructables.com/member/${u}/`, placeholder: "username or full link" },
  { id: "thingiverse", name: "Thingiverse", hosts: ["thingiverse.com"], user: (u) => `https://www.thingiverse.com/${u}/designs`, placeholder: "username or full link" },
  { id: "printables", name: "Printables", hosts: ["printables.com"], user: (u) => `https://www.printables.com/@${u}`, placeholder: "username or full link" },
  { id: "pinterest", name: "Pinterest", hosts: ["pinterest.com", "pinterest.co.uk", "pinterest.ca", "pin.it"], user: (u) => `https://www.pinterest.com/${u}/`, placeholder: "username or full link" },
  { id: "tiktok", name: "TikTok", hosts: ["tiktok.com"], user: (u) => `https://www.tiktok.com/@${u}`, placeholder: "username or full link" },
  { id: "bluesky", name: "Bluesky", hosts: ["bsky.app"], user: (u) => `https://bsky.app/profile/${u}`, placeholder: "handle or full link" },
].map((n) => ({ ...n, color: BRAND_PATHS[n.id] ? `#${BRAND_PATHS[n.id].hex}` : "", path: BRAND_PATHS[n.id]?.path || "" }));

const BY_ID = new Map(NETWORKS.map((n) => [n.id, n]));
export const network = (id) => BY_ID.get(id) || BY_ID.get("website");

// The network a link belongs to, from its address (anything else is "Website").
export function networkOf(url) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  } catch {
    return network("website");
  }
  return NETWORKS.find((n) => n.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || network("website");
}

// A full https link from what was typed: a link, or a username for the chosen network.
// Returns "" when it can't be made into a safe web address.
export function linkFrom(networkId, value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  const ok = (u) => {
    try {
      const url = new URL(u);
      return /^https?:$/.test(url.protocol) && url.hostname.includes(".") && !url.username && !url.password ? url.href : "";
    } catch {
      return "";
    }
  };
  if (/^https?:\/\//i.test(v)) return ok(v);
  const n = network(networkId);
  const name = v.replace(/^@/, "");
  if (n.user && /^[\w.-]{1,100}$/.test(name)) return ok(n.user(name));
  // "example.com/me" typed without https://
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return ok(`https://${v}`);
  return "";
}

// Editor rows for a list of saved links.
export const linkRows = (urls) => (urls || []).filter(Boolean).map((url) => ({ url, network: networkOf(url).id }));
