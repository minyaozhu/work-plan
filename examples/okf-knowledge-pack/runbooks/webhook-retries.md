---
type: runbook
title: "Stripe Webhook Retries & Deduplication"
description: "Stripe can deliver duplicate or out-of-order invoice events up to 72h later. Guard handlers with unique stripe_event_id inserts."
tags: [stripe, webhooks, idempotency]
files: [src/webhooks/stripe.ts]
inject_mode: "on_demand"
confidence: "confirmed"
---

# Stripe Webhook Retries & Deduplication

1. Verify the `Stripe-Signature` header against the raw request body before parsing JSON.
2. Insert `stripe_event_id` into `processed_webhook_events` with a `UNIQUE` constraint inside the same transaction as ledger posting.
3. Run `npm test -- test/stripe-webhooks.test.ts` after modifying webhook handlers.
