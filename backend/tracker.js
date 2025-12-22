import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const wallets = [
  "0xYourInternalWallet1",
  "0xYourInternalWallet2"
];

async function fetchWalletPositions(address) {
  const res = await axios.get(
    `https://api.polymarket.com/data/positions?wallet=${address}`
  );
  return res.data;
}

function generateSignal(positions) {
  // Sample proprietary signal logic
  const market = positions[0]?.market || "Unknown Market";
  const signalType = Math.random() > 0.5 ? "Buy YES" : "Buy NO";
  const pnl = (Math.random() - 0.5) * 200; // Simulated $100 bet result
  return { signal: `${signalType} on ${market}`, pnl };
}

async function trackWallet(address) {
  const positions = await fetchWalletPositions(address);
  const { signal, pnl } = generateSignal(positions);

  const { data: wallet } = await supabase
    .from("wallets")
    .select("id")
    .eq("wallet_address", address)
    .single();

  await supabase.from("signals").insert([{
    wallet_id: wallet.id,
    signal,
    pnl
  }]);

  console.log("Signal saved:", signal, "PnL:", pnl.toFixed(2));
}

async function main() {
  setInterval(() => {
    wallets.forEach(trackWallet);
  }, 30 * 1000); // every 30 seconds
}

main();
