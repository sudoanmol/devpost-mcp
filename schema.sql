-- The crawl database, which the MCP server reads as-is.
-- source says where a hackathon came from ('devpost' or 'plume'). Devpost's own ids are positive; other
-- sources use negative ids and slugs prefixed with the source ('plume:pr-…'), so the two never collide.

CREATE TABLE IF NOT EXISTS hackathons (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  organization TEXT,
  dates TEXT,
  ends_on TEXT,
  status TEXT,
  location TEXT,
  themes TEXT,
  prize_total TEXT,
  registrations INTEGER,
  winners_announced INTEGER,
  submissions INTEGER,
  tagline TEXT,
  description TEXT,
  judging_criteria TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hackathons_ends_on ON hackathons(ends_on);

CREATE TABLE IF NOT EXISTS prizes (
  id INTEGER PRIMARY KEY,
  hackathon_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  value TEXT,
  winners TEXT,
  description TEXT,
  entrants INTEGER,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prizes_hackathon ON prizes(hackathon_id);

CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT,
  likes INTEGER,
  built_with TEXT,
  description TEXT,
  links TEXT,
  updated_at TEXT NOT NULL
);

-- one row per (project, hackathon) entry; prizes is a JSON list of prize titles won there
CREATE TABLE IF NOT EXISTS submissions (
  slug TEXT NOT NULL,
  hackathon_id INTEGER NOT NULL,
  winner INTEGER NOT NULL,
  prizes TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (slug, hackathon_id)
);
CREATE INDEX IF NOT EXISTS submissions_hackathon ON submissions(hackathon_id, winner);

CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
  name, tagline, built_with, content='projects', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
  INSERT INTO projects_fts(rowid, name, tagline, built_with) VALUES (new.rowid, new.name, new.tagline, new.built_with);
END;
CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
  INSERT INTO projects_fts(projects_fts, rowid, name, tagline, built_with) VALUES ('delete', old.rowid, old.name, old.tagline, old.built_with);
END;
CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
  INSERT INTO projects_fts(projects_fts, rowid, name, tagline, built_with) VALUES ('delete', old.rowid, old.name, old.tagline, old.built_with);
  INSERT INTO projects_fts(rowid, name, tagline, built_with) VALUES (new.rowid, new.name, new.tagline, new.built_with);
END;

-- index-wide counts, refreshed by the crawler before each upload
CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value);

-- meaning-based search, written by server/src/build-index.ts
-- version: the embedding recipe in build-index.ts; rows from an older recipe get re-embedded
CREATE TABLE IF NOT EXISTS embeddings (slug TEXT PRIMARY KEY, vec BLOB NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  size INTEGER NOT NULL,
  winners INTEGER NOT NULL,
  recent INTEGER NOT NULL,
  label TEXT,
  centroid BLOB NOT NULL,
  examples TEXT,
  top_winners TEXT
);
CREATE TABLE IF NOT EXISTS project_topics (slug TEXT PRIMARY KEY, topic INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS project_topics_topic ON project_topics(topic);
