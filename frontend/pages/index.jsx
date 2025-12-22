import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_KEY
);

export default function Dashboard() {
  const [signals, setSignals] = useState([]);

  useEffect(() => {
    async function loadSignals() {
      const { data } = await supabase
        .from("signals")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      setSignals(data);
    }

    loadSignals();
    const interval = setInterval(loadSignals, 10000); // refresh every 10s
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <h1>Curated Polymarket Signals</h1>
      <table>
        <thead>
          <tr>
            <th>Signal</th>
            <th>Simulated $100 PnL</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {signals.map(s => (
            <tr key={s.id}>
              <td>{s.signal}</td>
              <td>{s.pnl.toFixed(2)}</td>
              <td>{new Date(s.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
