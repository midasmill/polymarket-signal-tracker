import { createClient } from "@supabase/supabase-js";
import pkg from "pg";
const { Pool } = pkg;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const pool = new Pool({ connectionString: COCKROACHDB_URL, ssl: { rejectUnauthorized: false } });

async function transferWallets() {
  const { data: wallets } = await supabase.from("wallets").select("polymarket_proxy_wallet");
  for (const w of wallets) {
    await pool.query(
      `INSERT INTO wallets (polymarket_proxy_wallet) VALUES ($1)`,
      [w.polymarket_proxy_wallet]
    );
  }
  console.log("✅ Transfer complete");
}

transferWallets();
