import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

// ---------------------------
// ENV
// ---------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase keys required");
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("Telegram config required");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const POLL_INTERVAL = 30 * 1000;

// ---------------------------
// Telegram
// ---------------------------
async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
}

// ---------------------------
// Polymarket API
// ---------------------------
async function fetchWalletTrades(wallet) {
  const res = await fetch(`https://polymarket.com/api/trades?user=${wallet}`);
  return res.ok ? res.json() : [];
}

async function fetchMarket(marketId) {
  const res = await fetch(`https://polymarket.com/api/markets/${marketId}`);
  return res.ok ? res.json() : null;
}

// ---------------------------
// Track wallet
// ---------------------------
async function trackWallet(wallet) {
  if (wallet.paused) return;

  const trades = await fetchWalletTrades(wallet.wallet_address);
  if (!trades.length) return;

  const latest = trades[0];

  // Prevent duplicates
  const { data: existing } = await supabase
    .from("signals")
    .select("id")
    .eq("tx_hash", latest.transactionHash)
    .maybeSingle();

  if (existing) return;

  const side = latest.outcome === "Yes" ? "YES" : "NO";

  const signal = {
    wallet_id: wallet.id,
    signal: latest.marketQuestion,
    side,
    market_id: latest.marketId,
    tx_hash: latest.transactionHash,
    outcome: "Pending",
    created_at: new Date(latest.timestamp)
  };

  await supabase.from("signals").insert(signal);

  await sendTelegram(
    `Signal Sent\nMarket: ${signal.signal}\nBuy: ${side}\nOutcome: Pending`
  );
}

// ---------------------------
// Resolve outcomes
// ---------------------------
async function updatePendingOutcomes() {
  const { data: pending } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending");

  if (!pending?.length) return;

  let resolvedAny = false;

  for (const sig of pending) {
    const market = await fetchMarket(sig.market_id);
    if (!market || !market.resolved) continue;

    const winningSide = market.winningOutcome === "Yes" ? "YES" : "NO";
    const result = sig.side === winningSide ? "WIN" : "LOSS";

    await supabase
      .from("signals")
      .update({ outcome: result, outcome_at: new Date() })
      .eq("id", sig.id);

    await sendTelegram(
      `Outcome Update\nMarket: ${sig.signal}\nResult: ${result}`
    );

    resolvedAny = true;
  }

  if (!resolvedAny) return;

  // Summary
  const { data: summary } = await supabase
    .from("signals")
    .select("outcome")
    .in("outcome", ["WIN", "LOSS"]);

  const wins = summary.filter(s => s.outcome === "WIN").length;
  const losses = summary.filter(s => s.outcome === "LOSS").length;
  const winRate = ((wins / (wins + losses)) * 100).toFixed(2);

  await supabase.from("notes")
    .update({
      content: `<p>Summary: ${wins} WIN(s), ${losses} LOSS(es), Win Rate: ${winRate}%</p>`,
      public: true
    })
    .eq("slug", "polymarket-millionaires");
}

// ---------------------------
// Main loop
// ---------------------------
async function main() {
  console.log("🚀 Polymarket tracker live (REAL DATA)");

  setInterval(async () => {
    try {
      await updatePendingOutcomes();

      const { data: wallets } = await supabase.from("wallets").select("*");
      for (const wallet of wallets) {
        await trackWallet(wallet);
      }
    } catch (e) {
      console.error("Loop error:", e);
    }
  }, POLL_INTERVAL);
}

main();
