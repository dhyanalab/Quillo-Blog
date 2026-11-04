import { createAdStore } from "./ads.js";
import { createMediaStore } from "./media.js";
import { createCommentStore, createMemberStore } from "./members.js";
import { createPostStore } from "./posts.js";
import { createRateLimitStore } from "./rate-limits.js";
import { createSettingsStore } from "./settings.js";
import { createNewsletterStore, createSubscriberStore } from "./newsletter.js";
import { createRedirectStore, createTaxonomyStore } from "./taxonomy.js";
import { createUserStore } from "./users.js";

// All data access. `onChange` fires after any write that can change a public page.
// `secrets` ({ seal, open, hmac }, from src/web/secrets.js) protects authenticator secrets, the SMTP password and
// recovery codes at rest. Without it (old callers, scripts) they are stored as before.
export function createStore(db, { basePath, onChange = () => {}, secrets } = {}) {
  const deps = { onChange, secrets };
  return {
    db,
    settings: createSettingsStore(db, deps),
    users: createUserStore(db, deps),
    media: createMediaStore(db, deps),
    posts: createPostStore(db, { ...deps, basePath }),
    ...createTaxonomyStore(db, deps),
    redirects: createRedirectStore(db, deps),
    subscribers: createSubscriberStore(db, deps),
    newsletters: createNewsletterStore(db),
    members: createMemberStore(db, deps),
    comments: createCommentStore(db, deps),
    ads: createAdStore(db, deps),
    rateLimits: createRateLimitStore(db),
  };
}
