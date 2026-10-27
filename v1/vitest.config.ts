import { defineConfig } from 'vitest/config'

/**
 * The suite reads `.env.example`, never the operator's `.env`.
 *
 * config/store.ts resolves `ENV_FILE ?? .env` once at import and, for the hot keys, lets
 * the FILE win. On the box the suite therefore ran against the live .env: on 2026-09-06 a
 * test that sized a drawdown breach as a fixed -$107 failed the deploy the moment the kill
 * switch was raised to $160, and every test worker was loading MODE=live LIVE=1 from the
 * trading file. `.env.example` is shipped with every deploy, documents every key, and does
 * not move when the operator changes a limit, so it is the one fixture both machines share.
 * A test that needs its own values (test/hotconfig.test.ts) still sets ENV_FILE itself
 * before importing the store, and that assignment wins over this default.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: { ENV_FILE: '.env.example' },
  },
})
