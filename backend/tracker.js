import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import fetch from "node-fetch";

// ---------------------------
// Environment variables
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required.");
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("Telegram bot info required.");

// ---------------------------
// Supabase client (service role key bypasses RLS)
// ---------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------
// Polling interval (ms)
// ---------------------------
const POLL_INTERVAL = 30 * 1000; // 30 seconds

// ---------------------------
// Telegram alert function
// ---------------------------
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
      }),
    });
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}

// ---------------------------
// Generate proprietary signal
// ---------------------------
function generateSignal(positions) {
  if (!positions || positions.length === 0) return null;

  const market = positions[0]?.market || "Unknown Market";
  const signalType = Math.random() > 0.5 ? "Buy YES" : "Buy NO";
  const pnl = (Math.random() - 0.5) * 200; // simulated $100 bet (-100 → +100)
  return { signal: `${signalType} on ${market}`, pnl };
}

// ---------------------------
// Fetch positions from API
// ---------------------------
async function fetchWalletPositions(walletAddress) {
  try {
    const res = await axios.get(`https://api.polymarket.com/v1/positions?wallet=${walletAddress}`);
    return res.data || [];
  } catch (err) {
    console.error(`Error fetching positions for ${walletAddress}:`, err.message);
    return [];
  }
}

// ---------------------------
// Track wallet
// ---------------------------
async function trackWallet(wallet) {
  if (wallet.paused) {
    console.log(`Wallet ${wallet.wallet_address} is paused due to losing streak.`);
    return;
  }

  const positions = await fetchWalletPositions(wallet.wallet_address);
  if (!positions || positions.length === 0) return;

  const result = generateSignal(positions);
  if (!result) return;

  // Insert into signals table
  await supabase.from("signals").insert([{
    wallet_id: wallet.id,
    signal: result.signal,
    pnl: result.pnl,
    created_at: new Date().toISOString()
  }]);

  // Update losing streak
  let losingStreak = wallet.losing_streak || 0;
  if (result.pnl < 0) losingStreak += 1;
  else losingStreak = 0;

  const paused = losingStreak >= 3; // auto-pause after 3 losses

  await supabase.from("wallets").update({ losing_streak: losingStreak, paused }).eq("id", wallet.id);

  // Update notes content
  const noteContent = `<p>Latest signal: ${result.signal} | PnL: ${result.pnl.toFixed(2)}</p>`;
  await supabase.from("notes")
    .update({ content: noteContent, public: true })
    .eq("slug", "polymarket-millionaires");

  // Telegram alert
  await sendTelegram(`Signal: ${result.signal}\nPnL: ${result.pnl.toFixed(2)}`);
}

// ---------------------------
// Main loop
// ---------------------------
async function main() {
  console.log("🚀 Polymarket wallet tracker started with losing-streak auto-pause and Telegram updates.");

  setInterval(async () => {
    try {
      // Get all wallets dynamically from Supabase
      const { data: wallets, error } = await supabase.from("wallets").select("*");
      if (error) {
        console.error("Error fetching wallets:", error);
        return;
      }

      for (const wallet of wallets) {
        await trackWallet(wallet);
      }
    } catch (err) {
      console.error("Tracker loop error:", err);
    }
  }, POLL_INTERVAL);
}

main();
