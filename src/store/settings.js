import crypto from "node:crypto";
import { transaction } from "../db.js";
import { isSealed, secretsOrPlain } from "./sql.js";

// Every site setting with its default. Admin > Settings edits these; values are stored as JSON.
export const SETTING_DEFAULTS = {
  site_title: "IoT Studio Blog",
  site_description: "Step-by-step ESP32, Arduino and IoT projects, tutorials and news, tested on real hardware.",
  site_url: "http://localhost:4100",
  org_name: "IoT Studio Blog",
  timezone: "Asia/Kolkata",
  logo_id: null,
  default_og_image_id: null,
  home_url: "",
  // The business behind the blog: shown in the footer and on legal pages, and given to search engines.
  business_name: "",
  brand_name: "",
  brand_url: "",
  address_street: "",
  address_city: "",
  address_region: "",
  address_postcode: "",
  address_country: "",
  contact_phone: "",
  contact_email: "",
  contact_email_alt: "",
  about_text: "IoT Studio makes it easy to build connected devices with ESP32: wiring, code and a phone dashboard for every project.",
  // The site's social profiles (footer and Organization "sameAs"), from the links editor in Settings.
  social_links: [],
  // Older one-field-per-network settings, still read until social_links is saved.
  social_youtube: "",
  social_instagram: "",
  social_x: "",
  social_linkedin: "",
  social_facebook: "",
  social_github: "",
  cta_download_url: "",
  cta_download_label: "Download IoT Studio (free)",
  cta_kit_url: "",
  cta_kit_label: "Get the Starter Kit",
  // Menus: "auto" builds them from categories and pages; "custom" uses the items chosen in Admin > Menus.
  nav_mode: "auto",
  nav_items: [], // [{label, url, children: [{label, url}]}]
  footer_mode: "auto",
  footer_cols: [], // [{title, links: [{label, url}]}]
  // Older text menus ("Label | URL" lines), still read when no custom menu was saved.
  nav_menu: "",
  footer_menu: "",
  // Sponsor banners: the master switch, places switched off, what an empty place shows,
  // and where "Advertise with us" leads.
  ads_enabled: true,
  ads_places_off: [],
  ads_empty: "show",
  ads_contact_url: "",
  posts_per_page: 12,
  // The category whose posts fill the News column on the home page and in sidebars.
  news_category_slug: "news",
  comments_enabled: true,
  // "none": comments go live at once; "first": a reader's first comment waits for approval; "all": every comment waits.
  comments_moderation: "first",
  members_signup: true,
  ai_training: "allow",
  indexnow_enabled: true,
  indexnow_key: "",
  google_verification: "",
  bing_verification: "",
  yandex_verification: "",
  pinterest_verification: "",
  facebook_verification: "",
  // Visitor analytics without cookies: "none", "plausible" or "umami", with the tracker's address.
  analytics_provider: "none",
  analytics_script: "",
  analytics_id: "", // Plausible: the site's domain (older scripts only). Umami: the website ID.
  analytics_host: "", // Umami: where events go, when it isn't the script's own server
  analytics_dashboard: "",
  // Two-step sign-in for staff: "off", "admins" (owner and administrators) or "staff" (everyone).
  require_two_step: "off",
  newsletter_enabled: true,
  newsletter_heading: "Get new projects in your inbox",
  newsletter_text: "Leave your email and we'll write when a new project goes live.",
  // Sending newsletters: who they come from, and the email service (SMTP) that delivers them.
  mail_from_name: "",
  mail_from_email: "",
  mail_reply_to: "",
  smtp_preset: "",
  smtp_host: "",
  smtp_port: 587,
  smtp_secure: "starttls", // "ssl" (port 465) or "starttls" (port 587)
  smtp_user: "",
  smtp_pass: "",
};

export const SOCIAL_KEYS = ["youtube", "instagram", "x", "linkedin", "facebook", "github"];

// Values that must never be handed out with the other settings. They are stored sealed (encrypted).
const SECRET_KEYS = new Set(["smtp_pass"]);
const MAX_VALUE_JSON = 200_000;
const ENUMS = { require_two_step: ["off", "admins", "staff"] };

// Does a value have the shape the setting's default has? (A string stays a string, a list a list, a picture id a whole number or empty.)
function fits(key, value) {
  const def = SETTING_DEFAULTS[key];
  if (key in ENUMS) return ENUMS[key].includes(value);
  if (def === null) return value === null || (Number.isInteger(value) && value > 0);
  if (Array.isArray(def)) return Array.isArray(value);
  if (typeof def === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === typeof def;
}
const clone = (v) => (v !== null && typeof v === "object" ? structuredClone(v) : v);

export function createSettingsStore(db, { onChange, secrets }) {
  const vault = secretsOrPlain(secrets);
  let cache = null;
  let sealed = {}; // secret values as stored (sealed), kept out of `cache`

  // The saved email password written before sealing existed is encrypted once, at start-up.
  if (vault.real) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get();
    if (row) {
      let plain = "";
      try {
        plain = JSON.parse(row.value);
      } catch {}
      if (typeof plain === "string" && plain && !isSealed(plain)) {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'smtp_pass'").run(JSON.stringify(vault.seal(plain, "settings.smtp_pass")));
      }
    }
  }

  // The site's search-engine key is made once, at start-up (a read of the settings never writes).
  const hasKey = db.prepare("SELECT value FROM settings WHERE key = 'indexnow_key'").get();
  let keyOk = false;
  try {
    keyOk = Boolean(hasKey) && typeof JSON.parse(hasKey.value) === "string" && JSON.parse(hasKey.value) !== "";
  } catch {}
  if (!keyOk) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('indexnow_key', ?)").run(JSON.stringify(crypto.randomBytes(16).toString("hex")));

  const load = () => {
    const stored = {};
    sealed = {};
    for (const r of db.prepare("SELECT key, value FROM settings").all()) {
      let value;
      try {
        value = JSON.parse(r.value);
      } catch {
        continue; // a damaged row falls back to the default instead of breaking every page
      }
      // Only known settings, and only values of the right type: a wrong-typed row falls back to the default
      // (an odd value must never break every page).
      if (!Object.hasOwn(SETTING_DEFAULTS, r.key)) continue;
      if (SECRET_KEYS.has(r.key)) sealed[r.key] = typeof value === "string" ? value : "";
      else if (fits(r.key, value)) stored[r.key] = value;
    }
    cache = { ...SETTING_DEFAULTS, ...stored };
    for (const key of SECRET_KEYS) delete cache[key];
    cache.smtp_pass_set = Boolean(sealed.smtp_pass); // lets the form say "a password is saved" without revealing it
    return cache;
  };

  return {
    // Every setting except the secrets (smtp_pass). `smtp_pass_set` says whether a password is saved.
    // A copy: changing what comes back never changes what other requests see.
    all: () => clone(cache || load()),
    get: (key) => (SECRET_KEYS.has(key) || !Object.hasOwn(SETTING_DEFAULTS, key) ? "" : clone((cache || load())[key])),
    // A secret, opened. Only for the code that needs it (the mailer).
    getSecret(key) {
      if (!SECRET_KEYS.has(key)) return "";
      if (!cache) load();
      return sealed[key] ? String(vault.open(sealed[key], "settings.smtp_pass") ?? "") : "";
    },
    // All keys are checked first, then everything is written in one transaction: no half-saved settings.
    set(values) {
      const entries = Object.entries(values);
      for (const [key, value] of entries) {
        if (!Object.hasOwn(SETTING_DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`);
        if (value === undefined || typeof value === "function" || typeof value === "symbol" || (typeof value === "number" && !Number.isFinite(value))) throw new Error(`Invalid value for setting: ${key}`);
        if (JSON.stringify(value).length > MAX_VALUE_JSON) throw new Error(`Setting is too long: ${key}`);
        if (!SECRET_KEYS.has(key) && !fits(key, value)) throw new Error(`Invalid value for setting: ${key}`);
        if ((key === "logo_id" || key === "default_og_image_id") && value !== null && db.prepare("SELECT kind FROM media WHERE id = ?").get(value)?.kind !== "image") throw new Error(`Invalid value for setting: ${key}`);
      }
      transaction(db, () => {
        const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
        for (const [key, value] of entries) {
          const stored = SECRET_KEYS.has(key) ? (typeof value === "string" && value ? vault.seal(value, `settings.${key}`) : "") : key === "indexnow_key" && !value ? crypto.randomBytes(16).toString("hex") : value;
          stmt.run(key, JSON.stringify(stored));
        }
      });
      cache = null;
      onChange();
    },
  };
}
