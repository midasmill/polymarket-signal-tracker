import fs from "fs";
import path from "path";
import csvParser from "csv-parser";
import pkg from "pg";
const { Pool } = pkg;

const COCKROACHDB_URL = process.env.COCKROACHDB_URL;
if (!COCKROACHDB_URL) throw new Error("COCKROACHDB_URL required");

const pool = new Pool({
  connectionString: COCKROACHDB_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function importCSVToTable(csvPath, tableName, columns) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(csvParser())
      .on("data", (data) => {
        const row = columns.map(col => data[col] ?? null);
        rows.push(row);
      })
      .on("end", async () => {
        console.log(`Read ${rows.length} rows from ${csvPath}`);
        for (const row of rows) {
          const placeholders = row.map((_, i) => `$${i + 1}`).join(",");
          const sql = `INSERT INTO ${tableName} (${columns.join(",")}) VALUES (${placeholders})`;
          try {
            await query(sql, row);
          } catch (err) {
            console.error(`Error inserting row into ${tableName}:`, err.message);
          }
        }
        console.log(`Finished importing ${tableName}`);
        resolve();
      })
      .on("error", reject);
  });
}

async function main() {
  try {
    // Adjust paths if needed
    const notesCsv = path.join(process.cwd(), "importnotes.csv");
    const walletsCsv = path.join(process.cwd(), "importwallets.csv");

    await importCSVToTable(notesCsv, "notes", [
      "id","title","content","emoji","category","slug","public","session_id","created_at"
    ]);

    await importCSVToTable(walletsCsv, "wallets", ["polymarket_proxy_wallet"]);

    console.log("✅ All CSVs imported successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Import failed:", err.message);
    process.exit(1);
  }
}

main();
