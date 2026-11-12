# Changelog

## 2026-11-11 — 1.1.0
### Changed
- Renamed to Basketly: package `@frostn/basketly`, command `basketly`
- The old `@frostn/amazon-mcp` package is deprecated
- Settings environment variables and the `~/.amazon-agent` session folder are unchanged
- Never retries around a block: a CAPTCHA or 503 now stops the guest session too, instead of starting a new one
- The agent tag can't be turned off; the sign-in browser no longer hides its automation flags
- Default user agent no longer claims to be a Mac

## 2026-11-09 — 1.0.1
### Fixed
- Product availability shows only the visible text; Amazon's nested page scripts no longer leak into it
- Sold-out sizes and colours no longer report that they can be added to the cart

## 2026-11-05 — 1.0.0 (first public release)
### Added
- MCP server for Amazon: search with photos and prices, product details, size/colour options, your real cart (add, remove, tick items), orders and package tracking, price-drop alerts
- Buying with your confirmation: the app shows a confirmation dialog (or a 6-digit code only you can see); the order is re-checked and placed once
- Product, cart and order cards for apps that support MCP Apps (Claude, ChatGPT, VS Code)
- `amazon-mcp serve`: the same server over HTTP behind a secret URL, for claude.ai and the Claude phone apps (Cloudflare quick tunnel, or your own URL with `--public-url`)
- Sign-in once on Amazon's real page, in a window or through a one-time link from your phone; the session is kept alive
- One `amazon-mcp` command: stdio server by default, `serve`, and a CLI for every tool
- Every request identifies itself as an AI shopping agent; challenges are reported, never bypassed
### Fixed
- Search cards: tall product photos no longer overlap the title
- Size/colour chips: stray commas around Amazon's option names are removed
