-- White-label (Quillo 1.0): a new blog starts neutral ("My Blog", no topic features, initials as its mark).
-- A blog that already exists when this update runs (it has staff accounts) keeps how it looked and read: its
-- current look and wording are saved as settings, so the new neutral defaults never change it.
-- INSERT OR IGNORE keeps any value the blog had already saved. A brand-new database has no users yet, so it gets none of these.

-- New settings, set to how existing blogs already worked.
INSERT OR IGNORE INTO settings (key, value) SELECT 'brand_mark', '"chip"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'post_features', '["code","downloads","tested"]' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'og_locale', '"en_IN"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'ads_empty', '"show"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'post_noun', '"project"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'post_noun_plural', '"projects"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'ads_pitch', '[{"icon":"users","title":"Readers who build","text":"Makers, students and engineers who follow the projects and buy the parts to build them."},{"icon":"chip","title":"Right beside the projects","text":"Your banner sits next to step-by-step builds, where readers choose their boards, sensors and tools."},{"icon":"chart","title":"Clear numbers","text":"You get the views and clicks of your banner for every day it runs."}]' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'ads_who', '["Electronics shops and distributors","Board, module and sensor makers","PCB and 3D-printing services","Tool and test-equipment brands","Courses and training for makers"]' WHERE EXISTS (SELECT 1 FROM users);

-- The defaults from before this update, for any of them an existing blog never saved.
INSERT OR IGNORE INTO settings (key, value) SELECT 'site_title', '"IoT Studio Blog"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'org_name', '"IoT Studio Blog"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'site_description', '"Step-by-step ESP32, Arduino and IoT projects, tutorials and news, tested on real hardware."' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'timezone', '"Asia/Kolkata"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'about_text', '"IoT Studio makes it easy to build connected devices with ESP32: wiring, code and a phone dashboard for every project."' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'cta_download_label', '"Download IoT Studio (free)"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'cta_kit_label', '"Get the Starter Kit"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'newsletter_heading', '"Get new projects in your inbox"' WHERE EXISTS (SELECT 1 FROM users);
INSERT OR IGNORE INTO settings (key, value) SELECT 'newsletter_text', '"Leave your email and we''ll write when a new project goes live."' WHERE EXISTS (SELECT 1 FROM users);
