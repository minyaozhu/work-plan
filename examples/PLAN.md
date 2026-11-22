# Billing Engine v2 Migration

## 1. Ledger Schema & Migrations
- [x] Add double-entry ledger tables (`db/migrations/014_ledger.sql`)
- [x] Write idempotent backfill script (`scripts/backfill-ledger.ts`)

## 2. Billing Core API
- [ ] Implement ledger posting service (`src/billing/posting.ts`)
- [ ] Handle Stripe invoice webhooks (`src/webhooks/stripe.ts`)
- [ ] Nightly balance reconciliation job (`src/jobs/reconcile.ts`)

## 3. Shadow Traffic & Cutover
- [ ] Dual-write shadow verification (`src/gateway/shadow.ts`)
- [ ] Production cutover & feature flag (`docs/cutover-runbook.md`)
