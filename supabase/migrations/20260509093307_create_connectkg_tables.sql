/*
  # ConnectKG Dating Bot Tables

  1. New Tables
    - `users` - Bot users with profile info (telegram_id, name, age, gender, about, photo_id, active)
    - `likes` - Like records between users (from_id, to_id)
    - `matches` - Mutual matches between users (user1_id, user2_id)
    - `ads` - Ads shown on match (text, active)

  2. Security
    - Enable RLS on all tables
    - Service role key used by bot has full access via policies
*/

CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  telegram_id bigint UNIQUE NOT NULL,
  name text NOT NULL DEFAULT '',
  age integer NOT NULL DEFAULT 0,
  gender text NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  photo_id text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS likes (
  id bigserial PRIMARY KEY,
  from_id bigint NOT NULL REFERENCES users(telegram_id),
  to_id bigint NOT NULL REFERENCES users(telegram_id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(from_id, to_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id bigserial PRIMARY KEY,
  user1_id bigint NOT NULL REFERENCES users(telegram_id),
  user2_id bigint NOT NULL REFERENCES users(telegram_id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(user1_id, user2_id)
);

CREATE TABLE IF NOT EXISTS ads (
  id bigserial PRIMARY KEY,
  text text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on users"
  ON users FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role insert on users"
  ON users FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role update on users"
  ON users FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role delete on users"
  ON users FOR DELETE
  TO service_role
  USING (true);

CREATE POLICY "Service role full access on likes"
  ON likes FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role insert on likes"
  ON likes FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role delete on likes"
  ON likes FOR DELETE
  TO service_role
  USING (true);

CREATE POLICY "Service role full access on matches"
  ON matches FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role insert on matches"
  ON matches FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role full access on ads"
  ON ads FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role insert on ads"
  ON ads FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "Service role update on ads"
  ON ads FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role delete on ads"
  ON ads FOR DELETE
  TO service_role
  USING (true);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_gender ON users(gender);
CREATE INDEX IF NOT EXISTS idx_likes_from_id ON likes(from_id);
CREATE INDEX IF NOT EXISTS idx_likes_to_id ON likes(to_id);
CREATE INDEX IF NOT EXISTS idx_matches_user1 ON matches(user1_id);
CREATE INDEX IF NOT EXISTS idx_matches_user2 ON matches(user2_id);
