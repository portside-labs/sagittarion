#!/usr/bin/env python3
"""Create a sample SQLite database used by tests and the mock SSH server."""
import os
import sys
import sqlite3
import random

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'sample.db')
for suffix in ('', '-wal', '-shm', '-journal'):
    try:
        os.remove(path + suffix)
    except OSError:
        pass

random.seed(42)
conn = sqlite3.connect(path)
c = conn.cursor()
c.executescript('''
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  age INTEGER,
  balance REAL DEFAULT 0,
  is_admin BOOLEAN NOT NULL DEFAULT 0,
  bio TEXT,
  avatar BLOB,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total REAL NOT NULL,
  status TEXT CHECK (status IN ('pending','paid','shipped','cancelled')) DEFAULT 'pending',
  notes TEXT,
  placed_at TEXT NOT NULL
);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status_placed ON orders(status, placed_at DESC);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value,
  updated_at TEXT
) WITHOUT ROWID;
CREATE TABLE "weird name" (
  "col with space" TEXT,
  "quote""d" INTEGER,
  rowid TEXT
);
CREATE TABLE big_numbers (id INTEGER PRIMARY KEY, n INTEGER, f REAL);
CREATE VIEW order_summary AS
  SELECT u.id AS user_id, u.name, count(o.id) AS order_count, coalesce(sum(o.total), 0) AS total_spent
  FROM users u LEFT JOIN orders o ON o.user_id = u.id
  GROUP BY u.id;
CREATE TRIGGER orders_touch_user AFTER INSERT ON orders
BEGIN
  UPDATE users SET balance = balance - NEW.total WHERE id = NEW.user_id;
END;
''')

first = ['Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Guido', 'Hedy',
         'Alan', 'Edsger', 'Frances', 'Tim', 'Anita', 'Bjarne', 'Yukihiro', 'Sophie', 'Niklaus', 'Zoë']
last = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson', 'Perlman', 'van Rossum',
        'Lamarr', 'Turing', 'Dijkstra', 'Allen', 'Berners-Lee', 'Borg', 'Stroustrup', 'Matsumoto', 'Wilson',
        'Wirth', 'Müller']
users = []
for i in range(1, 61):
    name = '%s %s' % (first[(i * 7) % len(first)], last[(i * 3) % len(last)])
    email = None if i % 9 == 0 else '%s.%s@example.com' % (first[(i * 7) % len(first)].lower().replace('ë', 'e'), i)
    age = None if i % 11 == 0 else random.randint(19, 82)
    balance = round(random.uniform(-500, 5000), 2)
    bio = None
    if i % 4 == 0:
        bio = 'Line one of a longer biography for %s.\nLine two mentions "quotes" and unicode: 日本語, emoji 🚀.' % name
    avatar = bytes(random.getrandbits(8) for _ in range(random.randint(16, 300))) if i % 6 == 0 else None
    users.append((i, name, email, age, balance, 1 if i % 10 == 0 else 0, bio, avatar,
                  '2024-%02d-%02d %02d:%02d:00' % (random.randint(1, 12), random.randint(1, 28), random.randint(0, 23), random.randint(0, 59))))
c.executemany('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)', users)

statuses = ['pending', 'paid', 'shipped', 'cancelled']
orders = []
for i in range(1, 401):
    orders.append((random.randint(1, 60), round(random.uniform(5, 900), 2), random.choice(statuses),
                   None if i % 5 else 'Gift wrap; leave at door', '2024-%02d-%02d' % (random.randint(1, 12), random.randint(1, 28))))
c.executemany('INSERT INTO orders (user_id, total, status, notes, placed_at) VALUES (?,?,?,?,?)', orders)

c.executemany('INSERT INTO settings VALUES (?,?,?)', [
    ('theme', 'dark', '2024-01-01'),
    ('max_items', 250, '2024-02-02'),
    ('ratio', 0.75, None),
    ('payload', b'\x00\x01\x02\xff', None),
])
c.executemany('INSERT INTO "weird name" VALUES (?,?,?)', [('a b', 1, 'r1'), ('c d', 2, 'r2')])
c.executemany('INSERT INTO big_numbers (n, f) VALUES (?,?)', [
    (9007199254740993, 1.5), (-9223372036854775808, 1e300), (42, float('nan')), (7, float('inf')), (8, 2.0)])
conn.commit()
conn.close()
print('wrote', path)
