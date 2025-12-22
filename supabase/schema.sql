
-- Wallets table
create table wallets (
  id serial primary key,
  wallet_address text not null,
  active boolean default true
);

-- Signals table
create table signals (
  id serial primary key,
  wallet_id int references wallets(id),
  signal text not null,
  pnl numeric,
  created_at timestamp default now()
);
