-- Fixture for the PostgreSQL tests. Idempotent: drops and recreates everything it owns.
DROP SCHEMA IF EXISTS analytics CASCADE;
DROP VIEW IF EXISTS order_summary;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS no_pk;
DROP TABLE IF EXISTS "weird name";
DROP FUNCTION IF EXISTS touch_updated_at();
DROP FUNCTION IF EXISTS order_total(bigint);
DROP PROCEDURE IF EXISTS archive_orders(date);

CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  age integer,
  balance numeric(12, 2) DEFAULT 0,
  is_admin boolean NOT NULL DEFAULT false,
  bio text,
  avatar bytea,
  tags text[] DEFAULT '{}',
  profile jsonb,
  ext_id uuid DEFAULT gen_random_uuid(),
  ratio double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  name_upper text GENERATED ALWAYS AS (upper(name)) STORED
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total numeric(10, 2) NOT NULL,
  status text CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')) DEFAULT 'pending',
  notes text,
  placed_at date NOT NULL
);
CREATE INDEX idx_orders_user ON orders (user_id);
CREATE INDEX idx_orders_status_placed ON orders (status, placed_at DESC);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text,
  updated_at timestamptz
);

CREATE TABLE no_pk (
  a integer,
  b text
);

CREATE TABLE "weird name" (
  "col with space" text,
  "quote""d" integer PRIMARY KEY
);

CREATE VIEW order_summary AS
  SELECT u.id AS user_id, u.name, count(o.id) AS order_count, coalesce(sum(o.total), 0) AS total_spent
  FROM users u LEFT JOIN orders o ON o.user_id = u.id
  GROUP BY u.id;

CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION order_total(order_id bigint) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT total::numeric FROM orders WHERE id = order_id
$$;

CREATE PROCEDURE archive_orders(before date) LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM orders WHERE placed_at < before;
END
$$;

CREATE SCHEMA analytics;
CREATE TABLE analytics.daily_totals (
  day date PRIMARY KEY,
  orders integer NOT NULL,
  revenue numeric(12, 2) NOT NULL
);

INSERT INTO users (name, email, age, balance, is_admin, bio, avatar, tags, profile, ratio)
SELECT
  (ARRAY['Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Guido', 'Hedy'])[1 + (g % 10)] || ' ' ||
  (ARRAY['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'van Rossum', 'Lamarr'])[1 + ((g * 3) % 10)],
  CASE WHEN g % 9 = 0 THEN NULL ELSE 'user' || g || '@example.com' END,
  CASE WHEN g % 11 = 0 THEN NULL ELSE 20 + (g * 7) % 60 END,
  ((g * 137) % 5000)::numeric / 100,
  g % 10 = 0,
  CASE WHEN g % 4 = 0 THEN E'Line one for user ' || g || E'.\nLine two with "quotes" and unicode: 日本語 🚀' END,
  CASE WHEN g % 6 = 0 THEN decode(md5(g::text), 'hex') END,
  CASE WHEN g % 3 = 0 THEN ARRAY['vip', 'beta'] ELSE ARRAY['beta'] END,
  jsonb_build_object('n', g, 'nested', jsonb_build_object('ok', g % 2 = 0)),
  CASE WHEN g % 5 = 0 THEN g::double precision ELSE g / 3.0 END
FROM generate_series(1, 60) AS g;

INSERT INTO orders (user_id, total, status, notes, placed_at)
SELECT 1 + (g * 7) % 60,
       ((g * 331) % 90000)::numeric / 100 + 5,
       (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[1 + (g % 4)],
       CASE WHEN g % 5 = 0 THEN 'Gift wrap; leave at door' END,
       date '2024-01-01' + (g % 365)
FROM generate_series(1, 400) AS g;

INSERT INTO settings VALUES ('theme', 'dark', now()), ('max_items', '250', NULL), ('ratio', '0.75', NULL);
INSERT INTO no_pk VALUES (1, 'a'), (2, 'b');
INSERT INTO "weird name" VALUES ('a b', 1), ('c d', 2);
INSERT INTO analytics.daily_totals VALUES ('2024-01-01', 12, 1234.50), ('2024-01-02', 7, 899.99);
