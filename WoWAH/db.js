const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'wowah.db'));

// WAL mode: readers never block behind writers
db.pragma('journal_mode = WAL');

// Drop old views before creating tables/indexes with the same names
try { db.exec("DROP VIEW IF EXISTS current_prices"); }       catch (e) {}
try { db.exec("DROP VIEW IF EXISTS current_realm_prices"); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    email                TEXT    UNIQUE NOT NULL,
    password_hash        TEXT    NOT NULL,
    is_verified          INTEGER DEFAULT 0,
    verification_token   TEXT,
    blizzard_access_token TEXT,
    created_at           TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id         INTEGER NOT NULL,
    quality    INTEGER NOT NULL DEFAULT 0,   -- crafting quality tier (1-5); 0 = no quality
    bonus_list TEXT    NOT NULL DEFAULT '',  -- sorted, comma-separated bonus IDs; '' = base item
    item_level INTEGER NOT NULL DEFAULT 0,   -- actual ilvl resolved with bonus IDs; 0 = base
    name       TEXT,
    icon       TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (id, quality, bonus_list)
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id               INTEGER PRIMARY KEY,
    name             TEXT,
    crafted_item_id  INTEGER NOT NULL,
    crafted_quantity REAL    NOT NULL DEFAULT 1,
    profession       TEXT,
    fetched_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reagents (
    recipe_id INTEGER NOT NULL,
    item_id   INTEGER NOT NULL,
    quantity  INTEGER NOT NULL,
    PRIMARY KEY (recipe_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL,
    unit_price  INTEGER NOT NULL,
    quantity    INTEGER NOT NULL,
    region      TEXT    NOT NULL,
    recorded_at TEXT    DEFAULT (datetime('now'))
  );

  -- Current commodity snapshot: wiped and replaced every fetch (fast reads, no view subquery)
  CREATE TABLE IF NOT EXISTS current_prices (
    item_id    INTEGER NOT NULL,
    quality    INTEGER NOT NULL DEFAULT 0,
    bonus_list TEXT    NOT NULL DEFAULT '',
    region     TEXT    NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity   INTEGER NOT NULL,
    recorded_at TEXT   NOT NULL,
    PRIMARY KEY (item_id, quality, bonus_list, region)
  );

  -- Connected realm registry
  CREATE TABLE IF NOT EXISTS realms (
    id                 INTEGER NOT NULL,
    connected_realm_id INTEGER NOT NULL,
    region             TEXT    NOT NULL,
    name               TEXT    NOT NULL,
    PRIMARY KEY (id, region)
  );

  -- Per-realm auction snapshots
  CREATE TABLE IF NOT EXISTS realm_prices (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id            INTEGER NOT NULL,
    quality            INTEGER NOT NULL DEFAULT 0,
    bonus_list         TEXT    NOT NULL DEFAULT '',
    connected_realm_id INTEGER NOT NULL,
    region             TEXT    NOT NULL,
    unit_price         INTEGER NOT NULL,
    quantity           INTEGER NOT NULL,
    recorded_at        TEXT    DEFAULT (datetime('now'))
  );

  -- Current realm snapshot: wiped and replaced per realm per fetch
  CREATE TABLE IF NOT EXISTS current_realm_prices (
    item_id            INTEGER NOT NULL,
    quality            INTEGER NOT NULL DEFAULT 0,
    bonus_list         TEXT    NOT NULL DEFAULT '',
    connected_realm_id INTEGER NOT NULL,
    region             TEXT    NOT NULL,
    unit_price         INTEGER NOT NULL,
    quantity           INTEGER NOT NULL,
    recorded_at        TEXT    NOT NULL,
    PRIMARY KEY (item_id, quality, bonus_list, connected_realm_id, region)
  );

  CREATE INDEX IF NOT EXISTS idx_price_history_region_item    ON price_history(region, item_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_realm_prices_realm_item      ON realm_prices(region, connected_realm_id, item_id, recorded_at);
  CREATE INDEX IF NOT EXISTS idx_current_prices_region        ON current_prices(region, item_id);
  CREATE INDEX IF NOT EXISTS idx_current_realm_region_realm   ON current_realm_prices(region, connected_realm_id, item_id);
  CREATE INDEX IF NOT EXISTS idx_recipes_crafted_item         ON recipes(crafted_item_id);
  CREATE INDEX IF NOT EXISTS idx_reagents_item                ON reagents(item_id);
  CREATE INDEX IF NOT EXISTS idx_items_icon                   ON items(icon);
`);

try { db.exec("ALTER TABLE recipes ADD COLUMN expansion TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE items ADD COLUMN quality INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE items ADD COLUMN bonus_list TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE items ADD COLUMN item_level INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE price_history ADD COLUMN quality INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE price_history ADD COLUMN bonus_list TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE current_prices ADD COLUMN quality INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE current_prices ADD COLUMN bonus_list TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE realm_prices ADD COLUMN quality INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE realm_prices ADD COLUMN bonus_list TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE current_realm_prices ADD COLUMN quality INTEGER NOT NULL DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE current_realm_prices ADD COLUMN bonus_list TEXT NOT NULL DEFAULT ''"); } catch (e) {}

// Drop any old views left from a previous schema version
try { db.exec("DROP VIEW IF EXISTS current_prices"); }       catch (e) {}
try { db.exec("DROP VIEW IF EXISTS current_realm_prices"); } catch (e) {}

module.exports = db;
