# Contributing

Thanks for helping! A few notes to keep the project healthy:

- **Logs are private by default.** Never commit `.ulg` or `.params` files (they are git-ignored). Tests that need real logs read them from paths given in environment variables (`ULOG_DIR`, `ULOG_REFERENCE`) and are skipped in CI.
- **Analysis code lives in `src/core/`** and must stay DOM-free (it runs in a Web Worker and in Node for tests). UI code lives in `src/app`, `src/pages`, `src/components`, `src/charts`.
- **Cross-check new analyses** against an independent implementation (Python/scipy, Flight Review, PX4 source) and add a unit test with synthetic data where possible.
- **PX4 version:** the target is PX4 v1.17 and newer; prefer current topic/field names.
- Run `npm run typecheck` and `npm test` before opening a pull request; CI runs the same plus the web and desktop builds.
- UI: Fluent UI 2 components and tokens, light and dark themes, check 100/125/150 % scaling.
