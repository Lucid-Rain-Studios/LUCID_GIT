// Regression suite for the Electron main-process git layer.
//
// These are Node tests, not browser tests — they drive the built
// `dist-electron` services against throwaway git repositories on disk. They
// run serially and never in parallel: GitService is a singleton with caches,
// and every test spawns real git processes.
const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  // Cloning and LFS round-trips are slower than a unit test but far short of
  // the operations they stand in for.
  timeout: 120_000,
  reporter: [['list']],
})
