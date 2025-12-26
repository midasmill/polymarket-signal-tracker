import { createClient } from "@supabase/supabase-js";
import pkg from "pg";
const { Pool } = pkg;

/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase credentials required");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const COCKROACH_URL = process.env.COCKROACHDB_URL;
if (!COCKROACH_URL) throw new Error("CockroachDB URL required");

const pool = new Pool({
  connectionString: COCKROACH_URL,
  ssl: { rejectUnauthorized: false },
});

/* ===========================
   Query Helper
=========================== */
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

/* ===========================
   Migration Script
=========================== */
async function migrateWallets(batchSize = 100) {
  let offset = 0;
  let totalMigrated = 0;

  while (true) {
    const { data: wallets, error } = await supabase
      .from("wallets")
      .select("polymarket_proxy_wallet")
      .range(offset, offset + batchSize - 1);

    if (error) throw new Error(`Supabase fetch error: ${error.message}`);
    if (!wallets || wallets.length === 0) break;

    // Insert into Cockroach
    const insertPromises = wallets.map(w => {
      if (!w.polymarket_proxy_wallet) return null;
      return query(
        `INSERT INTO wallets (polymarket_proxy_wallet) 
         VALUES ($1)
         ON CONFLICT (polymarket_proxy_wallet) DO NOTHING`,
        [w.polymarket_proxy_wallet]
      );
    });

    await Promise.all(insertPromises);
    totalMigrated += wallets.length;
    console.log(`Migrated ${totalMigrated} wallets so far...`);

    offset += batchSize;
  }

  console.log(`✅ Migration complete. Total wallets migrated: ${totalMigrated}`);
}

/* ===========================
   Run Migration
=========================== */
migrateWallets().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
