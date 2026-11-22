---
type: convention
title: "Minor-Unit Integer Money Representation"
description: "All monetary amounts are stored and passed as BIGINT minor units (cents) paired with ISO-4217 currency codes; never use floats."
tags: [money, types, billing]
inject_mode: "always"
confidence: "confirmed"
---

# Minor-Unit Integer Money Representation

- Store all amounts as 64-bit integers (`BIGINT`) in currency minor units (e.g., USD cents).
- Always pair every amount with an explicit ISO-4217 currency code (`USD`, `EUR`, etc.).
- Never use floating-point numbers (`number` / `FLOAT` / `DOUBLE`) for money arithmetic.
