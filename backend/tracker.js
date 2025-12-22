import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

/* ===========================
   ENV
=========================== */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Supabase keys required");
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)
  throw new Error("Telegram config required");

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

const POLL_INTERVAL = 30 * 1000;

/* ===========================
   TELEGRAM
=========================== */
async function sendTelegram(text) {
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text
      })
    }
  );
}

/* ===========================
   POLYMARKET API
=========================== */

// Fallback (wallet based – unreliable but kept)
async function fetchWalletTrades(wallet) {
  const res = await fetch(
    `https://polymarket.com/api/trades?user=${wallet}`
  );
  return res.ok ? res.json() : [];
}

// Preferred (user-based)
async function fetchUserTrades(userId) {
  const res = await fetch(
    `https://polymarket.com/api/users/${userId}/trades?limit=50`
  );
  if (!res.ok) return [];
  const json = await res.json();
  return json?.trades || [];
}

async function fetchMarket(marketId) {
  const res = await fetch(
    `https://polymarket.com/api/markets/${marketId}`
  );
  return res.ok ? res.json() : null;
}

/* ===========================
   USER RESOLUTION
=========================== */
async function resolveUserFromProfile(wallet) {
  if (wallet.polymarket_user_id) return wallet;
  if (!wallet.polymarket_profile_url) return wallet;

  const username = wallet.polymarket_profile_url.split("@")[1];
  if (!username) return wallet;

  const res = await fetch(
    `https://polymarket.com/api/users?username=${username}`
  );

  if (!res.ok) return wallet;

  const json = await res.json();
  const user = json?.users?.[0];
  if (!user?.id) return wallet;

  await supabase
    .from("wallets")
    .update({
      polymarket_username: username,
      polymarket_user_id: user.id
    })
    .eq("id", wallet.id);

  return {
    ...wallet,
    polymarket_username: username,
    polymarket_user_id: user.id
  };
}

/* ===========================
   CONFIDENCE HELPERS
=========================== */
function getConfidenceEmoji(count) {
  if (count >= 10) return "⭐⭐⭐";
  if (count >= 5) return "⭐⭐";
  return "⭐";
}

function confidenceToNumber(c) {
  if (c === "⭐") return 1;
  if (c === "⭐⭐") return 2;
  if (c === "⭐⭐⭐") return 3;
  return 0;
}

/* ===========================
   MAJORITY LOGIC
=========================== */
async function getMarketVoteCounts(marketId) {
  const { data } = await supabase
    .from("signals")
    .select("wallet_id, side")
    .eq("market_id", marketId);

  if (!data || data.length === 0) return null;

  const walletVotes = {};

  for (const s of data) {
    walletVotes[s.wallet_id] ||= { YES: 0, NO: 0 };
    walletVotes[s.wallet_id][s.side] = 1;
  }

  let yesVotes = 0;
  let noVotes = 0;

  for (const v of Object.values(walletVotes)) {
    if (v.YES && v.NO) {
      yesVotes += 0.5;
      noVotes += 0.5;
    } else if (v.YES) yesVotes += 1;
    else if (v.NO) noVotes += 1;
  }

  return { yesVotes, noVotes };
}

function getMajoritySide(v) {
  if (!v) return null;
  if (v.yesVotes > v.noVotes) return "YES";
  if (v.noVotes > v.yesVotes) return "NO";
  return null;
}

/* ===========================
   TRACK WALLET
=========================== */
async function trackWallet(wallet) {
  if (wallet.paused) return;

  wallet = await resolveUserFromProfile(wallet);

  let trades = [];

  if (wallet.polymarket_user_id) {
    console.log("Fetching USER trades:", wallet.polymarket_username);
    trades = await fetchUserTrades(wallet.polymarket_user_id);
  } else {
    console.log("Fallback WALLET trades:", wallet.wallet_address);
    trades = await fetchWalletTrades(wallet.wallet_address);
  }

  if (!trades.length) return;

  for (const trade of trades) {
    if (trade.marketResolved) continue;

    const tradeId =
      trade.id || trade.transactionHash;

    const { data: exists } = await supabase
      .from("signals")
      .select("id")
      .eq("tx_hash", tradeId)
      .maybeSingle();

    if (exists) continue;

    const side =
      trade.outcome === "Yes" ? "YES" : "NO";

    await supabase.from("signals").insert({
      wallet_id: wallet.id,
      signal: trade.marketQuestion,
      side,
      market_id: trade.marketId,
      tx_hash: tradeId,
      outcome: "Pending",
      created_at: new Date(trade.timestamp)
    });
  }
}

/* ===========================
   SEND CONFIDENCE UPDATES
=========================== */
async function sendMajoritySignals() {
  const { data: markets } = await supabase
    .from("signals")
    .select("market_id")
    .group("market_id");

  for (const m of markets) {
    const votes = await getMarketVoteCounts(m.market_id);
    const side = getMajoritySide(votes);
    if (!side) continue;

    const count = Math.max(
      votes.yesVotes,
      votes.noVotes
    );
    const confidence = getConfidenceEmoji(count);

    const { data: last } = await supabase
      .from("signals")
      .select("last_confidence_sent")
      .eq("market_id", m.market_id)
      .eq("side", side)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (
      confidenceToNumber(confidence) >
      confidenceToNumber(last?.last_confidence_sent)
    ) {
      await supabase
        .from("signals")
        .update({ last_confidence_sent: confidence })
        .eq("market_id", m.market_id)
        .eq("side", side);

      await sendTelegram(
        `Confidence Update:\nMarket: ${m.market_id}\nPrediction: ${side}\nConfidence: ${confidence}`
      );
    }
  }
}

/* ===========================
   RESOLVE OUTCOMES
=========================== */
async function updatePendingOutcomes() {
  const { data: pending } = await supabase
    .from("signals")
    .select("*")
    .eq("outcome", "Pending");

  if (!pending?.length) return;

  let updated = false;

  for (const sig of pending) {
    const market = await fetchMarket(sig.market_id);
    if (!market || !market.resolved) continue;

    const winSide =
      market.winningOutcome === "Yes" ? "YES" : "NO";

    await supabase
      .from("signals")
      .update({
        outcome:
          sig.side === winSide ? "WIN" : "LOSS",
        outcome_at: new Date()
      })
      .eq("id", sig.id);

    updated = true;
  }

  if (updated) await sendMajoritySignals();
}

/* ===========================
   MAIN LOOP
=========================== */
async function main() {
  console.log("🚀 Polymarket tracker live (REAL DATA)");

  setInterval(async () => {
    try {
      const { data: wallets } = await supabase
        .from("wallets")
        .select("*");

      console.log("WALLETS LOADED:", wallets?.length);

      for (const wallet of wallets) {
        await trackWallet(wallet);
      }

      await updatePendingOutcomes();
    } catch (e) {
      console.error("Loop error:", e);
    }
  }, POLL_INTERVAL);
}

main();
