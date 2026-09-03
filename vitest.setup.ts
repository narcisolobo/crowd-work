try {
  process.loadEnvFile();
} catch {
  // .env not present (e.g. CI) — tests that need its variables will fail
  // with a clear "missing required environment variable" error instead.
}
