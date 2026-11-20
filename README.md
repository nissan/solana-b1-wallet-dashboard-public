# Solana B1 Wallet Dashboard

A Next.js prototype for connecting a Wallet Standard wallet, viewing SOL and SPL balances, sending SOL and classic SPL tokens, and reading recent activity. [Watch the devnet demo](https://youtu.be/YVFAs9KUtLs).

This is a source snapshot of `4adaf2d2a61f0b3e976e4ab62036d7a8862e6f1f`. The private build journal, issue history and evidence artifacts are not part of this repository. The earlier video shows balances and sends, not recent activity.

Install the Node.js and pnpm versions pinned in `mise.toml`, then run:

```sh
cd app
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000`. Use devnet or a local validator, not real funds. If configuring Helius, set `HELIUS_API_KEY` in `app/.env.local`; never expose it through a `NEXT_PUBLIC_` variable. Never commit keys.

The demo used an injected test wallet, not a browser extension. Token-2022 balances can be displayed but not sent. The activity list can miss inbound transfers involving only a token account. Tests use Surfpool and may need an available upstream RPC for fork data.

```sh
pnpm test
pnpm build
```
