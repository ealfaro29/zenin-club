-- Uploaded videos for collections and the landing hero, plus site settings.
-- Additive and rerunnable. Video bytes live in the DESIGNS R2 bucket under videos/.
CREATE TABLE IF NOT EXISTS video_assets (
 id TEXT PRIMARY KEY CHECK (length(id) = 64),
 object_key TEXT NOT NULL UNIQUE,
 content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/webm')),
 byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 52428800),
 created_at TEXT NOT NULL,
 actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_settings (
 key TEXT PRIMARY KEY,
 version INTEGER NOT NULL DEFAULT 1,
 value_json TEXT NOT NULL CHECK (json_valid(value_json)),
 updated_at TEXT NOT NULL
);
