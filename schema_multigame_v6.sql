-- MATCH-UP UNIVERSAL MULTI-GAME TABLES V6
-- Safe to add alongside the existing V5 tables.

CREATE TABLE IF NOT EXISTS mg_runs (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  game_title TEXT,
  config_url TEXT NOT NULL,
  answer_key TEXT NOT NULL,
  pair_count INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  elapsed_ms INTEGER,
  matches INTEGER NOT NULL DEFAULT 0,
  mistakes INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  raw_score INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  accuracy_multiplier REAL,
  speed_multiplier REAL,
  score INTEGER,
  leaderboard_eligible INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 0,
  submitted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mg_runs_game
ON mg_runs(game_id);

CREATE TABLE IF NOT EXISTS mg_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  raw_score INTEGER NOT NULL,
  mistakes INTEGER NOT NULL,
  best_streak INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES mg_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_mg_scores_game_rank
ON mg_scores(game_id, score DESC, elapsed_ms ASC);

CREATE INDEX IF NOT EXISTS idx_mg_scores_expiry
ON mg_scores(expires_at);

CREATE TABLE IF NOT EXISTS mg_daily_champions (
  game_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  score_id INTEGER NOT NULL,
  PRIMARY KEY (game_id, day_key),
  FOREIGN KEY (score_id) REFERENCES mg_scores(id)
);

CREATE TABLE IF NOT EXISTS mg_all_time_record (
  game_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  raw_score INTEGER NOT NULL,
  mistakes INTEGER NOT NULL,
  best_streak INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  achieved_at INTEGER NOT NULL
);
