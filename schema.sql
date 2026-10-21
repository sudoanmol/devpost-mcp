-- Shared by the local crawl database and D1.

CREATE TABLE IF NOT EXISTS hackathons (
  id INTEGER PRIMARY KEY,
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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prizes_hackathon ON prizes(hackathon_id);

CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
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
