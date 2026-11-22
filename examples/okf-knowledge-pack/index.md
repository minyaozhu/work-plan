---
okf_version: "0.2"
title: "Billing Engine v2 Knowledge Pack"
description: "Sample Open Knowledge Format (OKF) bundle demonstrating architecture, conventions, and runbooks for Work Plan."
license: "MIT"
---

# Billing Engine v2 Knowledge Pack

## Architecture
* [Immutable Append-Only Ledger](architecture/ledger-schema.md) - Double-entry ledger tables and serializable transaction rules

## Conventions
* [Minor-Unit Integer Money Representation](conventions/money-minor-units.md) - Store all monetary amounts as BIGINT minor units (cents)

## Runbooks
* [Stripe Webhook Retries & Deduplication](runbooks/webhook-retries.md) - Guard webhook handlers against duplicate and out-of-order deliveries
