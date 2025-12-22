import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

// ---------------------------
// ENV
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase keys required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------
// Helpers
// ---------------------------
function getUsernameFromProfileUrl(url) {
  const match = url.match(/\/@([^\/?#]+)/);
  return match ? match[1] : null;
}

async function getUserIdFromUsername(username) {
  try {
    const res = await fetch(`https://polymarket.com/api/users/${username}`);
    if (!res.ok) throw new Error(`Failed to fetch user ${username}`);
    const data = await res.json();
    return data.id; // numeric Polymarket user ID
  } catch (err) {
    console.error("Error fetching user ID:", err.message);
    return null;
  }
}

// ---------------------------
// Main
// ---------------------------
async function updateWalletUserIds() {
  // Fetch wallets missing user ID
  const { data: wallets, error } = await supabase
    .from("wallets")
    .select("*")
    .not("polymarket_profile_url", "is", null)
    .is("polymarket_user_id", null);

  if (error) {
    console.error("Error fetching wallets:", error);
    return;
  }

  console.log(`Found ${wallets.length} wallets to update`);

  for (const wallet of wallets) {
    const username = getUsernameFromProfileUrl(wallet.polymarket_profile_url);
    if (!username) {
      console.log(`Skipping wallet ${wallet.id}: cannot extract username`);
      continue;
    }

    const userId = await getUserIdFromUsername(username);
    if (!userId) {
      console.log(`Skipping wallet ${wallet.id}: could not fetch user ID`);
      continue;
    }

    const { error: updateError } = await supabase
      .from("wallets")
      .update({ polymarket_user_id: userId })
      .eq("id", wallet.id);

    if (updateError) {
      console.error(`Failed to update wallet ${wallet.id}:`, updateError);
    } else {
      console.log(`Wallet ${wallet.id} updated with user ID ${userId}`);
    }
  }

  console.log("✅ Update complete");
}

// Run
updateWalletUserIds();
