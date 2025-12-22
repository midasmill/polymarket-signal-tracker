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
// Telegram helper
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
// Confidence helper
// ---------------------------
function getConfidenceEmoji(count) {
  if (count >= 10) return "⭐⭐⭐";
  if (count >= 5) return "⭐⭐";
  return "⭐";
}

// ---------------------------
// Track unresolved trades for a wallet
// ---------------------------
async function trackUnresolvedWalletTrades(wallet) {
  if (wallet.paused) return;

  const trades = await fetchWalletTrades(wallet.wallet_address);
  if (!trades.length) return;

  for (const trade of trades) {
    const side = trade.outcome === "Yes" ? "YES" : "NO";

    // Check if market + side already exists
    const { data: existingSignal } = await supabase
      .from("signals")
      .select("*")
      .eq("market_id", trade.marketId)
      .eq("side", side)
      .maybeSingle();

    if (existingSignal) {
      // If this wallet is new for this signal, increment wallet_count
      if (!existingSignal.wallets?.includes(wallet.wallet_address)) {
        const newCount = (existingSignal.wallet_count || 1) + 1;
        const updatedWallets = [...(existingSignal.wallets || []), wallet.wallet_address];
        await supabase
          .from("signals")
          .update({ wallet_count: newCount, wallets: updatedWallets })
          .eq("id", existingSignal.id);

        // Telegram confidence update
        await sendTelegram(
          `Confidence Update:\nMarket: ${trade.marketQuestion}\nPrediction: ${side}\nConfidence: ${getConfidenceEmoji(newCount)}`
        );
      }
      continue; // Already tracked
    }

    // Insert new signal
    await supabase.from("signals").insert({
      signal: trade.marketQuestion,
      side,
      market_id: trade.marketId,
      outcome: "Pending",
      wallet_count: 1,
      wallets: [wallet.wallet_address],
      created_at: new Date(trade.timestamp)
    });

    // Telegram initial alert
    await sendTelegram(
      `Signal Sent\nMarket: ${trade.marketQuestion}\nPrediction: ${side}\nOutcome: Pending\nConfidence: ⭐`
    );
  }
}

// ---------------------------
// Update Notes feed
// ---------------------------
async function updateNotesFeed() {
  const { data: signals } = await supabase
    .from("signals")
    .select("*")
    .order("created_at", { ascending: false });

  if (!signals) return;

  const MAX_SIGNALS = 50;
  const contentArray = [];

  for (const sig of signals.slice(0, MAX_SIGNALS)) {
    const confidence = getConfidenceEmoji(sig.wallet_count || 1);
    const outcomeText = sig.outcome || "Pending";
    const timestamp = new Date(sig.created_at).toLocaleString("en-US");

    contentArray.push(
      `<p>
         Signal Sent: ${timestamp}<br>
         Market: ${sig.signal}<br>
         Prediction: ${sig.side}<br>
         Outcome: ${outcomeText}<br>
         Confidence: ${confidence}
       </p>`
    );
  }

  const newContent = contentArray.join("");
  await supabase
    .from("notes")
    .update({ content: newContent, public: true })
    .eq("slug", "polymarket-millionaires");
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

    resolvedAny = true;
  }

  if (resolvedAny) {
    await updateNotesFeed();
  }
}

// ---------------------------
// Main loop
// ---------------------------
async function main() {
  console.log("🚀 Polymarket tracker live (REAL DATA)");

  setInterval(async () => {
    try {
      await updatePendingOutcomes();

      // Fetch all wallets
      const { data: wallets } = await supabase.from("wallets").select("*");

      for (const wallet of wallets) {
        await trackUnresolvedWalletTrades(wallet);
      }

      await updateNotesFeed();
    } catch (e) {
      console.error("Loop error:", e);
    }
  }, POLL_INTERVAL);
}

main();
