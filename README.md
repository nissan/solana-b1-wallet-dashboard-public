# Solana B1 Wallet Dashboard

A Next.js prototype for connecting a Wallet Standard wallet, viewing SOL and SPL balances, sending SOL and classic SPL tokens, and reading recent activity. [Watch the devnet demo](https://youtu.be/ilLkL9ucQBs).

This is a source snapshot of `6182eb964b043b0b71f864aa9f893396c5fcda08`. The private build journal, issue history and evidence artifacts are not part of this repository, so code comments that point to `docs/evidence/` refer to files that are not here. The earlier video shows balances and sends, not recent activity.

Install the Node.js and pnpm versions pinned in `mise.toml`, then run:

```sh
cd app
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000`. Use devnet or a local validator, not real funds. If configuring Helius, set `HELIUS_API_KEY` in `app/.env.local`; never expose it through a `NEXT_PUBLIC_` variable. Never commit keys.

The demo used an injected test wallet, not a browser extension. Token-2022 balances can be displayed but not sent. Recent activity includes incoming token transfers by reading up to 10 of the wallet's token accounts, those holding a balance first; transfers into token accounts beyond that are not listed. The card states that limit under its heading. When more than 10 token accounts hold a balance, it also says how many of those were read. A deposit that was later moved out of an unread, now-empty token account is not listed and not warned about. If activity has not loaded within 15 seconds, the card shows an error and a Retry button. Tests run on an offline Surfpool network with the mainnet accounts they need saved in `app/tests/fixtures/`, so they need no upstream RPC. `pnpm build` still downloads Google Fonts.

```sh
pnpm test
pnpm build
```
