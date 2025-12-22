import * as dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { createClient } from "@supabase/supabase-js";

/* =========================================================
   SUPABASE SETUP
========================================================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================================================
   TELEGRAM ALERTS
========================================================= */
async function sendTelegramMessage(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: "Markdown"
    });
  } catch (err) {
    console.error("Telegram send error:", err.response?.data || err.message);
  }
}

async function sendTelegramSignal(wallet, signal, pnl, totalPositions, losingStreak) {
  const message = `
📢 *New Signal Generated*
Wallet: \`${wallet}\`
Signal: *${signal}*
PnL: $${pnl.toFixed(2)}
Open Positions: ${totalPositions}
Current Losing Streak: ${losingStreak}
  `;
  await sendTelegramMessage(message);
}

async function sendTelegramPause(wallet, losingStreak) {
  const message = `
⚠️ *Wallet Auto-Paused*
Wallet: \`${wallet}\`
Reason: ${losingStreak} consecutive losses
All further signals for this wallet are paused until manually resumed.
  `;
  await sendTelegramMessage(message);
}

/* =========================================================
   FETCH WALLET POSITIONS
========================================================= */
async function fetchWalletPositions(address) {
  try {
    const res = await axios.get(
      `https://data-api.polymarket.com/positions?user=${address}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    return res.data;
  } catch (err) {
    console.error("Error fetching positions:", err.response?.data || err.message);
    return [];
  }
}

/* =========================================================
   SIGNAL GENERATION
========================================================= */
function generateSignal(position) {
  if (!position) return { signal: "No positions", pnl: 0 };

  const market = position.title || "Unknown Market";
  const signalType = Math.random() > 0.5 ? "Buy YES" : "Buy NO";

  const baseAmount = 100; // $100 simulated
  const pnl = (Math.random() - 0.5) * 2 * baseAmount;

  return { signal: `${signalType} on ${market}`, pnl };
}

/* =========================================================
   TRACK A SINGLE WALLET
========================================================= */
async function trackWallet(walletRow) {
  const address = walletRow.wallet_address;

  if (walletRow.paused) {
    console.log("Wallet paused due to losing streak:", address);
    return;
  }

  const positions = await fetchWalletPositions(address);
  if (!positions || positions.length === 0) {
    console.log("No positions for wallet:", address);
    return;
  }

  for (const pos of positions) {
    const { signal, pnl } = generateSignal(pos);

    // Insert internal signals
    await supabase.from("signals").insert([{ wallet_id: walletRow.id, signal, pnl }])
      .catch(err => console.error("Insert error (signals):", err.message));

    // Insert public curated signals
    await supabase.from("curated_signals").insert([{ signal, pnl }])
      .catch(err => console.error("Insert error (curated_signals):", err.message));

    console.log("Signal saved:", signal, "PnL:", pnl.toFixed(2));

    // Telegram alert with extra details
    const totalPositions = positions.length;
    const losingStreak = walletRow.losing_streak || 0;
    await sendTelegramSignal(address, signal, pnl, totalPositions, losingStreak);

    // Update losing streak
    if (pnl < 0) {
      await updateLosingStreak(walletRow.id, true, address);
    } else {
      await updateLosingStreak(walletRow.id, false, address);
    }
  }
}

/* =========================================================
   UPDATE LOSING STREAK
========================================================= */
const MAX_LOSING_STREAK = 3;

async function updateLosingStreak(wallet_id, lost, walletAddress) {
  const { data: wallet, error } = await supabase
    .from("wallets")
    .select("losing_streak, paused")
    .eq("id", wallet_id)
    .single();

  if (error || !wallet) return;

  let newStreak = lost ? wallet.losing_streak + 1 : 0;
  let paused = wallet.paused;

  if (newStreak >= MAX_LOSING_STREAK && !paused) {
    paused = true;
    console.log(`Wallet ${wallet_id} auto-paused after ${newStreak} losses`);
    await sendTelegramPause(walletAddress, newStreak);
  }

  await supabase
    .from("wallets")
    .update({ losing_streak: newStreak, paused })
    .eq("id", wallet_id);
}

/* =========================================================
   FETCH ALL WALLETS
========================================================= */
async function fetchWallets() {
  const { data, error } = await supabase
    .from("wallets")
    .select("id, wallet_address, losing_streak, paused");

  if (error) {
    console.error("Error fetching wallets:", error.message);
    return [];
  }

  return data;
}

/* =========================================================
   MAIN LOOP
========================================================= */
async function main() {
  console.log("🚀 Polymarket wallet tracker started. Tracking all wallets in Supabase.");

  async function runTracker() {
    const wallets = await fetchWallets();
    if (!wallets || wallets.length === 0) {
      console.log("No wallets found in Supabase.");
      return;
    }

    wallets.forEach(trackWallet);
  }

  // Run immediately
  await runTracker();

  // Poll every 30 seconds
  setInterval(runTracker, 30_000);
}

main();
