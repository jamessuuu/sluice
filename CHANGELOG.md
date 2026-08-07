# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: semver.

## [Unreleased]

### Added
- M0: pnpm workspace (core / store-postgres / testkit), TS strict +
  `noUncheckedIndexedAccess`, ESLint 9 flat config with the core
  no-node-builtins boundary rule, Vitest 4 unit+eval projects, five-stage CI
  (typecheck → lint → unit → e2e:smoke → eval) plus build + pack-check guards,
  MIT license with brand-asset carve-out, SPEC committed.
