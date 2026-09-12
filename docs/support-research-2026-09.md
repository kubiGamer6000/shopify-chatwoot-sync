# Support Conversation Research (September 2026)

Analysis of ~840 recent Chatwoot conversations (exported 2026-09-12: the latest 2,250 resolved, all 431 open and all 131 pending conversations, sampled up to 80 per classification label plus 120 multi-label threads). Ten parallel reviews covered refund, missing-packs + product-defect, not-delivered, change-address/contact/no-country, business + discount, other, order-status, sub-cancel, multi-intent, and system edge cases. Conversation numbers are cited as evidence.

It drove the acknowledgement design in [agent-bot.md](agent-bot.md) and the prompts in `src/config/acknowledgePrompt.txt` and `src/config/responderPrompt.txt`.

## Headline numbers

| Finding | Value |
|---|---|
| Human first-reply time (208 waits since Aug 1) | **median 52.7h**, p25 40.5h, p90 72.8h; only 11.5% within 24h |
| Non-English customers | ~15% (Swedish, Spanish, Danish/Norwegian, Portuguese, German, French, Dutch, Italian); humans reply in English |
| Order-status bot answers (51 reviewed) | 63% good, 20% weak (e.g. withheld tracking), 14% wrong or should have escalated |
| Sub-cancel senders unaware it was a subscription | ~49% |
| Sub-cancel cases hitting website failures (no cancel option, "no subscription found") | 14+ |
| Multi-label conversations carrying a stale or wrong label | ~55% |
| `business` conversations that are cold pitches / spam | ~62% (none got a useful human reply; genuine leads were also ignored) |
| Customer messages within 2 minutes of the previous one (bursts) | 1.8% |
| Currently `pending` conversations | 131: 104 end with our outbound outreach, 27 end with an unanswered customer message (all older than 30 days, mostly March–April legacy) |

## What customers were missing (drives "ask for")

| Intent | Most often missing from the first message |
|---|---|
| refund | order number or checkout email (~40%); whether they want the subscription stopped, the order refunded, or both |
| missing-packs | photo of contents (only 15% sent one), which flavours arrived, packaging/label photo |
| product-defect | flavour, all pieces or some, photo/batch number; for sensitivity: symptoms and duration |
| not-delivered | whether mailbox/neighbours/pickup point were checked (~15% said), courier notice, what the courier said |
| change-address | complete courier-ready address (complete in ~35%), order number (~50%), phone |
| discount-issue | the exact code, its source, order number, checkout screenshot |
| outreach replies | the fields our template asked for that are still missing (often phone or house number) |

## Recurring failure patterns

- **Promises before actions:** drafts said "I've cancelled / updated / refunded" before anyone acted (11243, 11710, 9186), invented email addresses (partnerships@, marketing@) and codes (9056 "ERIK48").
- **Status claims without data:** "fully protected and on its way" for unfulfilled orders; "moving through the carrier network" with no scans (11685); a cancelled order described as on its way (9205).
- **Replying to machines and pleasantries:** bot replied to an Outlook out-of-office (11415) and to Gmail emoji reactions (11626: 5 replies in 10 minutes).
- **Claimed to be human:** "I can assure you I'm a real person" (11162).
- **Bulk outreach sent To: our own inbox with customers in BCC** echoes back as a "customer" conversation and merges several customers' replies into one thread tied to an unrelated contact (10875, 11512, 11519); drafts then called our own template phishing (10889, 11514).
- **Duplicates:** contact form + email within minutes, chasers opening new conversations (10757/10909/11030, 11555/11556/11557).
- **Coverage gap:** Facebook conversations and replies into the Klaviyo sender inbox never reached the AgentBot.

## Inferred human policies (as practised, for reference)

- **Rebill disputes:** subscription cancelled immediately; order refund refused before delivery ("already in our shipping pipeline"); after delivery no returns but a goodwill partial refund, 30% standard, 50% on pushback or hardship, 70% maximum seen; full refunds for lost parcels, confirmed cancellation before the rebill, a quoted 90-day guarantee, or a withdrawn chargeback.
- **Missing packs:** photos first, then reship by default (23 of 52 `reshipped`); refund only when the customer picks it.
- **Not delivered (tracking says delivered):** customer checks locally, then contacts the courier; reship or refund only once treated as lost.
- **Address changes:** edited in Shopify if unshipped; if shipped, customer told to contact the courier.
- **No-country:** full refund and subscription cancelled; inconsistently, customs-ID requests for some of the same countries.
- **Inconsistencies worth resolving:** "consumables can't be returned" vs the website's 30-day return and "90-day money-back" promises; where the product is made/shipped from; whether some countries are served.

## Decisions for the owner

1. **Cancel on first request?** Evidence favours cancelling directly when a customer asks to stop the subscription (link replies read as dodging; the website often fails). The responder currently still sends the link first unless the customer insists or reports a website failure.
2. **Sub-cancel + refund:** cancel now and acknowledge the refund part, instead of handing off everything.
3. **Response-time wording:** acknowledgements currently promise no timeframe; add one if there's a service-level target (e.g. "within 1 to 2 business days").
4. **Partnerships inbox:** genuine leads get an acknowledgement but nobody follows up today.
5. **Knowledge base:** an approved fact sheet (ingredients, flavours, add-ons, shipping times per region, brand origin statement) would let the bot answer product and pre-sale questions.
6. **Legacy pending clean-up:** 27 conversations from March–April with unanswered customer messages (e.g. 176, 271, 408, 657, 7342, 7570) are older than the sweeper window.
7. **Attach the AgentBot** to the Facebook and Klaviyo-sender inboxes.
