import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

// ---------------------------
// ENV
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Supabase keys required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------
// Helper: fetch Polymarket user ID
// ---------------------------
async function fetchUserId(username) {
  try {
    const res = await fetch(`https://polymarket.com/api/users/${username}`);
    if (!res.ok) throw new Error(`Failed to fetch user ${username}`);
    const data = await res.json();
    return data?.id || null;
  } catch (err) {
    console.error("Error fetching user ID:", err.message);
    return null;
  }
}

// ---------------------------
// Main function
// ---------------------------
async function main() {
  console.log("🚀 Filling Polymarket usernames and user IDs...");

  const { data: wallets, error } = await supabase.from("wallets").select("*");
  if (error) {
    console.error("Error fetching wallets:", error);
    return;
  }

  for (const wallet of wallets) {
    try {
      if (!wallet.polymarket_profile_url) continue;

      // Extract username from URL, e.g., https://polymarket.com/@YLnas
      const match = wallet.polymarket_profile_url.match(/\/@([A-Za-z0-9_-]+)/);
      if (!match) {
        console.log(`Skipping wallet ${wallet.id}: cannot parse username`);
        continue;
      }

      const username = match[1];
      const userId = await fetchUserId(username);

      if (!userId) {
        console.log(`Skipping wallet ${wallet.id}: could not fetch user ID`);
        continue;
      }

      // Update wallet with username and user ID
      const { error: updateErr } = await supabase
        .from("wallets")
        .update({
          polymarket_username: username,
          polymarket_user_id: userId,
        })
        .eq("id", wallet.id);

      if (updateErr) {
        console.error(`Error updating wallet ${wallet.id}:`, updateErr);
      } else {
        console.log(`✅ Updated wallet ${wallet.id}: username=${username}, user_id=${userId}`);
      }
    } catch (err) {
      console.error("Unexpected error:", err);
    }
  }

  console.log("✅ Done filling usernames and user IDs.");
}

main();
