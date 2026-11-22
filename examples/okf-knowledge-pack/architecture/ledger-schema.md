---
type: architecture
title: "Immutable Append-Only Ledger"
description: "Never UPDATE or DELETE rows in ledger_entries; reversals must post compensating debit/credit pairs."
resource: "postgresql://prod/billing/ledger_entries"
tags: [ledger, sql, invariants]
files: [db/migrations/014_ledger.sql, src/billing/posting.ts]
inject_mode: "always"
confidence: "confirmed"
---

# Immutable Append-Only Ledger

- Never `UPDATE` or `DELETE` rows in `ledger_entries`; reversals must post compensating debit/credit pairs.
- Wrap every debit/credit posting batch in `SERIALIZABLE` isolation with up to 3 retries on Postgres `40001` serialization conflicts.
