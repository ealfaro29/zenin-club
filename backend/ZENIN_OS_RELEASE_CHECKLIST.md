# ZENIN CLUB OS — acceptance tests and deployment gate

Status: NOT DEPLOYED. Never apply these migrations to production without explicit approval.

## Required integration scenarios (D1 test database)

1. Create social request, quote in CRC, items totaling 1200000 minor units, no discount, workshop pickup. Expected deposit 600000, shipping 0.
2. Quote sent and accepted; receipt uploaded for 599999: verification alone must NOT create official order. Conversion returns 409.
3. Verify cumulative 600000 with explicit bank receipt confirmation and unique reference. Convert once: returns 201, ZC ID and private token. Retry returns existing ID with no new token and no duplicate.
4. Reject unverified screenshot and reused verified bank reference.
5. Workshop pickup: new -> preparing -> ready -> delivered only when balanceCollectedAtPickup=true. Cannot ship a pickup order.
6. Home delivery: quote shipping 250000 minor units, total 1450000; deposit 600000; remaining 850000. Confirm address, create order, new -> preparing -> ready. Cannot ship until full 1450000 verified. Then ready -> shipped -> delivered.
7. Tracking: ID only, wrong token, or email-only must not reveal social order. Correct token reveals only ID, status, history, delivery mode, and tracking number if present.
8. Concurrent conversion of same quote yields one order, one audit event, and no legacy inventory reservations.
9. Concurrent status updates from same state: only one should succeed.
10. Legacy Tilopay checkout, admin legacy orders, inventory triggers, and web tracking remain unchanged.

## Blocking gaps before production

- Implement and test authenticated delivery-mode/address intake and confirmation; no such endpoint is connected yet.
- Test all migrations 0012 through 0018 in a fresh D1 database and check foreign keys.
- Add automated tests for all scenarios above and run them; none are claimed to have passed.
- Implement the visual admin UI for quotes, verification, order queue, and state changes.
- Review privacy of admin responses and secret recovery; first conversion response is the only token issuance.
- Confirm D1 batch transaction and concurrent request behavior with real Cloudflare D1.
- WhatsApp official coexistence and Correos Sucursal Virtual label automation remain blocked pending supported integrations.
- Obtain separate approval before merging to main, deploying, or migrating production data.
