import crypto from "node:crypto";
import { transaction } from "../db.js";
import { isSealed, secretsOrPlain } from "./sql.js";
import { DESIGN_DEFAULTS, isDesign } from "../design.js";

// Every site setting with its default. Admin > Settings edits these; values are stored as JSON.
export const SETTING_DEFAULTS = {
  // A new blog starts neutral; first-run setup asks for its name, description and time zone.
  site_title: "My Blog",
  site_description: "",
  site_url: "http://localhost:4100",
  org_name: "My Blog",
  timezone: "UTC",
  // The region search engines and social cards are told the blog is written for (og:locale).
  og_locale: "en_US",
  logo_id: null,
  // What stands in for the logo when there is none: the title's initials, or one of the icons in BRAND_MARKS.
  brand_mark: "initials",
  // Topic features an editor can add to posts, switched on in Settings > Post features:
  // "code" (Source code box), "downloads" (download buttons and the GitHub button), "tested" (Tested with).
  post_features: [],
  // A small "Powered by" line in the footer. First-run setup turns it on unless the owner unticks it.
  show_powered_by: false,
  // What the blog calls a post, in phrases such as "Related posts" ("project" and "projects" on a projects blog).
  post_noun: "post",
  post_noun_plural: "posts",
  // The look chosen on Admin > Design: one option per group in src/design.js. The defaults are the original look.
  design: { ...DESIGN_DEFAULTS },
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
  about_text: "",
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
  cta_download_label: "Download",
  cta_kit_url: "",
  cta_kit_label: "Visit the shop",
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
  ads_empty: "hide", // a new blog shows no empty sponsor boxes until the owner asks for them
  ads_contact_url: "",
  // The Advertise page's sales text, edited in Admin > Ads: three reasons (icon, title, text) and who advertises here.
  ads_pitch: [
    { icon: "users", title: "Readers who come back", text: "People who follow this blog and act on what they read." },
    { icon: "eye", title: "Seen beside the posts", text: "Your banner sits next to the articles readers came for, not in a pile of other ads." },
    { icon: "chart", title: "Clear numbers", text: "You get the views and clicks of your banner for every day it runs." },
  ],
  ads_who: ["Shops and online stores", "Brands whose products our readers use", "Apps, tools and services", "Courses, events and training", "Local businesses"],
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
  newsletter_heading: "Get new posts in your inbox",
  newsletter_text: "Leave your email and we'll write when something new goes live.",
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
export const BRAND_MARKS = ["initials", "pen", "book", "chip", "code", "globe", "heart", "home", "image", "chart", "mobile"];
export const POST_FEATURES = ["code", "downloads", "tested"];
export const LOCALES = { en_US: "English, United States", en_GB: "English, United Kingdom", en_IN: "English, India", en_AU: "English, Australia", en_CA: "English, Canada", en_IE: "English, Ireland", en_NZ: "English, New Zealand", en_SG: "English, Singapore", en_ZA: "English, South Africa" };
const ENUMS = { require_two_step: ["off", "admins", "staff"], brand_mark: BRAND_MARKS, og_locale: Object.keys(LOCALES) };

// Does a value have the shape the setting's default has? (A string stays a string, a list a list, a picture id a whole number or empty.)
function fits(key, value) {
  const def = SETTING_DEFAULTS[key];
  if (key in ENUMS) return ENUMS[key].includes(value);
  if (def === null) return value === null || (Number.isInteger(value) && value > 0);
  if (key === "post_features") return Array.isArray(value) && value.every((f) => POST_FEATURES.includes(f));
  if (key === "ads_pitch") return Array.isArray(value) && value.length <= 3 && value.every((p) => p && typeof p.title === "string" && typeof p.text === "string" && typeof p.icon === "string");
  if (key === "design") return isDesign(value);
  if (key === "ads_who") return Array.isArray(value) && value.length <= 10 && value.every((w) => typeof w === "string");
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
