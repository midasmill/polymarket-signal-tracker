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
// Confidence helper
// ---------------------------
function getConfidenceEmoji(count) {
  if (count >= 10) return "⭐⭐⭐";
  if (count >= 5) return "⭐⭐";
  return "⭐";
}

// ---------------------------
// Track wallet
// ---------------------------
async function trackWallet(wallet) {
  if (wallet.paused) return;

  const trades = await fetchWalletTrades(wallet.wallet_address);
  if (!trades.length) return;

  const latest = trades[0];
  const side = latest.outcome === "Yes" ? "YES" : "NO";

  // ---------------------------
  // Aggregate signal per market+side
  // ---------------------------
  const { data: existingSignal } = await supabase
    .from("signals")
    .select("*")
    .eq("market_id", latest.marketId)
    .eq("side", side)
    .maybeSingle();

  if (existingSignal) {
    // Increment wallet count
    const newCount = (existingSignal.wallet_count || 1) + 1;
    await supabase
      .from("signals")
      .update({ wallet_count: newCount })
      .eq("id", existingSignal.id);

    // Telegram confidence update
    await sendTelegram(
      `Confidence Update:\nMarket: ${latest.marketQuestion}\nPrediction: ${side}\nConfidence: ${getConfidenceEmoji(newCount)}`
    );
    return;
  }

  // Insert new signal
  await supabase.from("signals").insert({
    signal: latest.marketQuestion,
    side,
    market_id: latest.marketId,
    outcome: "Pending",
    wallet_count: 1,
    created_at: new Date(latest.timestamp)
  });

  // ---------------------------
  // Telegram initial alert
  // ---------------------------
  await sendTelegram(
    `Signal Sent\nMarket: ${latest.marketQuestion}\nPrediction: ${side}\nOutcome: Pending\nConfidence: ⭐`
  );
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

  // Add summary line
  const wins = signals.filter(s => s.outcome === "WIN").length;
  const losses = signals.filter(s => s.outcome === "LOSS").length;
  const winRate = ((wins / (wins + losses || 1)) * 100).toFixed(2);
  const summaryLine = `<p>Summary: ${wins} WIN(s), ${losses} LOSS(es), Win Rate: ${winRate}%</p>`;

  contentArray.unshift(summaryLine);

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

      const { data: wallets } = await supabase.from("wallets").select("*");
      for (const wallet of wallets) {
        await trackWallet(wallet);
      }

      await updateNotesFeed();
    } catch (e) {
      console.error("Loop error:", e);
    }
  }, POLL_INTERVAL);
}

main();
