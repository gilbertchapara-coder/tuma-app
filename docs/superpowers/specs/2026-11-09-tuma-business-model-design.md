# Tuma: Business Model Design

Date: 9 Nov 2026
Status: draft for owner review (business model only; the app and how it is built are not decided)

"Tuma" is a loose Shona word meaning "send someone to deliver or do a task on your behalf".

## 1. Intent and why

Motorbike and bicycle riders in Zimbabwe and Zambia are being pushed to join large international platforms (Yango, inDrive) that take commission and add delivery fees. Riders are scattered around town with no easy way to be found by shops. Tuma is an open platform where shops and service providers meet riders directly, at a lower cost to both sides.

The owner's stated niche: heavy taxing and delivery fees charged by the international apps.

Origin note: the owner first explored a Mukuru-to-EcoCash wallet bridge. It was dropped because the area is crowded and tangled with regulators and large players. Tuma replaced it.

## 2. Goals, non-goals, anti-goals

Goals
- Give independent riders (motorbike and bicycle) steady paid work and a bigger share of each delivery fee.
- Give shops cheaper, predictable delivery.
- Run a pilot where parcel volume is dense enough for pooling to work.
- Reach a point where per-parcel fees plus a second income stream cover running costs.

Non-goals (for now)
- Ride-hailing for people. Tuma is parcels and errands.
- Covering whole cities from day one.
- Advertising income before volume exists.

Anti-goals (failure even if the app technically works)
- Tuma becomes another high-commission platform.
- Riders wait with no jobs because parcels are too scattered.
- Tuma breaks courier, tax or transport rules and is shut down.

## 3. Who it serves

- **Customer who pays Tuma's shop side:** shops and service providers who send parcels (my assumption: online sellers on WhatsApp and Facebook, pharmacies, hardware and clothing shops).
- **Riders:** motorbike riders, and bicycle riders for short distances (2 to 3 km bands).
- **End recipients:** the shop's customers. They choose the service level at checkout through the shop.

## 4. How it works

Service levels, chosen by the shop's customer:
- **Express:** one parcel, goes now, highest price. Works with no pooling, so the platform is useful from day one. Express is where the "auction" idea applies: urgent jobs are priced up. How the auction mechanism works in detail (riders bidding vs price rising with urgency) is a builder decision, see section 9.
- **Standard:** pooled, delivered the same day on a timetabled run.
- **Overnight:** pooled, delivered next morning. Cheapest.

Pooling by direction. The app groups parcels at set cutoff times (for example a late-morning cutoff for the afternoon run, an evening cutoff for the next-morning run) into runs. A rider sees an offer such as "5 parcels, South-West run, you earn $X". Drops along the way can be stacked in order.

Pilot runs in Harare (owner's list, grouped by direction; my placement, to be checked on a map):
- North: Avondale, Avenues, Milton Park.
- South-West: Mbare, Workington, Houghton Park.
- South: Waterfalls, Plymouth (Plymouth's position is uncertain).

Short drops (Avenues, Milton Park, about 2 km) suit bicycle riders. Longer drops suit motorbikes.

## 5. Money

How Tuma earns
- A flat fee of about 25 cents per completed parcel, deducted from the rider's prepaid balance ("float").
- Riders buy float by mobile money, as they already do on Yango and inDrive (owner's confirmation).
- The rider collects the delivery fee directly from the shop or customer, in cash or mobile money.
- A free period at the start while routes fill up.

Reference, how others earn (secondary sources, treat as approximate)
- Uber: about 27% blended take rate in 2025 (about 30% on rides, about 19% on delivery). Ads are a growing extra. Uber disputes outside claims that its cut is higher.
- inDrive: about 10% per ride, sometimes 5% to 8%, charged up front from the driver's wallet, with zero-commission launch periods.
- Yango: no published rate found. A Lusaka driver put the market at 10% to 15%.

Does 25 cents work?
- Lusaka (owner's data, K60 to K150 per delivery, about $2.60 to $6.50 at an assumed K23 per dollar): a K6 flat fee (about 25 cents) is roughly 4% to 10%, at or below inDrive.
- Harare (owner's data, $2 to $3 per delivery): 25 cents is roughly 8% to 12%. This is at or slightly above inDrive's 10%, so the fee in Harare may need to drop to 15 to 20 cents or be set by band.

Proposed prices, Harare, by distance band (my proposal, distances are estimates)

| Band | Suburbs | Express | Standard | Overnight |
|---|---|---|---|---|
| 2 km | Avenues, Milton Park | $2.00 | $1.20 | $1.00 |
| 3 km | Mbare | $2.00 | $1.30 | $1.10 |
| 4 to 5 km | Avondale, Workington | $2.50 | $1.50 | $1.20 |
| 6 to 7 km | Houghton Park | $3.00 | $1.80 | $1.50 |
| 8 to 10 km | Waterfalls, Plymouth | $3.50 | $2.00 | $1.70 |

Rider math, one South run of 5 Standard parcels to Waterfalls: 5 x $2.00 = $10, less 5 x 25c = $1.25, so $8.75 to the rider. The same rider doing one Express job nets about $2.75.

Scale (illustration)
- At K100 average and K6 per job, about 4,000 jobs a month earns Tuma about $1,000 (about 135 a day).
- If running Tuma cost $1,500 a month at 25 cents a parcel, break-even is 6,000 parcels a month (about 200 a day). These cost figures are placeholders, not estimates.

Second income stream, in priority order (my recommendation)
1. Shop subscription ($5 to $10 a month): bulk booking, tracking page, priority on pooled runs.
2. Partner commissions: rider insurance, bike repair, fuel deals.
3. Ads or featured shops, only after volume.

Pricing is the owner's to confirm; all prices above are proposals.

## 6. Biggest risk and how the design handles it

Risk: too few parcels in the same area at the same time, so pooling fails and riders sit idle.

Design responses (agreed in workflow; untested)
- Start in one dense corridor, not the whole city.
- Timetabled runs with cutoffs, so parcels only need to accumulate by the cutoff.
- Express works without pooling, so day-one value exists.
- Few riders at first (10 to 20), so each gets good work.
- Recruit a few high-volume senders first.
- Free fees during the early weeks.

The risk is designed around, not proven. Suggested test: a manual WhatsApp-and-spreadsheet pilot before any app.

## 7. Licensing, tax and legal (unverified, needs local advice)

- Zimbabwe: POTRAZ has treated courier services as needing a postal licence, and a runner was arrested in 2021 for operating without one. I could not confirm the current rules. ZIMRA is pursuing tax from app-based drivers, which may reach riders. Possible further requirements: transport licence, police clearance, insurance.
- Zambia: RTSA Statutory Instrument 19 of 2024 covers online hailing taxis. It does not clearly cover delivery. Two-wheeler rules are still being developed. No clear ZRA rule on delivery platforms was found.
- Whether riders are independent contractors, and who remits their tax, is an open legal question in both countries.
- Tuma itself must be tax-compliant. A Zimbabwean and a Zambian adviser should confirm before launch.

## 8. Competition

- inDrive already offers courier services in Zimbabwe. Yango has parcel delivery in Zambia.
- Expect them to respond with fee cuts. In Zambia, Yango was fined by the competition authority for below-cost pricing, which limits aggressive undercutting there.
- Tuma's defence is not price alone: pooled runs, local density, and direct shop relationships.

## 9. Left to the builder

- The exact Express "auction" mechanism (riders bid, or price rises with urgency).
- Trust and safety: rider checks, parcel handover proof, ratings, handling lost or damaged parcels.
- Platform choice (app, WhatsApp, USSD or a mix) and all technical decisions.
- How parcels are batched and how drop order is chosen.
- How the Zambia launch differs from Harare (the pilot there has a price, but no suburb list yet).

## 9a. Owner answers (9 Nov 2026, after the builder check)

The owner's replies were short. The readings below are the author's interpretation, to be confirmed on review.

1. **Matchmaker or courier?** "Hybrid." Reading: Tuma matches shops and riders but takes some responsibility for the handover (delivery code, rider checks, a claims route for lost parcels). Exactly how much liability Tuma carries, and whether riders post a deposit, is still open.
2. **Resources:** "Idea and money." Reading: the owner is bringing the idea and funding for the pilot. The amount, the time they can commit, and any team or partner are not stated.
3. **First shops:** "Secure." Reading: the owner will secure the first shops themselves. No names or parcel volumes given yet.
4. **Legal risk:** "Run it as a pilot." Reading: launch a small pilot first and complete licensing once it shows promise. The pilot should stay small and avoid holding large rider balances until the licensing position is clear.

5. **Build order:** the owner chose to build the app first, not a manual WhatsApp pilot. The author had suggested WhatsApp first as a cheaper test; this is the owner's decision and replaces that suggestion. The pilot risk (enough parcels on the same route) therefore gets tested with the app live, so the first release should be small: one corridor, a few riders, Express plus one pooled run, and a way to watch parcels per run from day one.

6. **WhatsApp:** a manual WhatsApp pilot is rejected as too cumbersome. WhatsApp ordering for shops may be added later as a feature of the app, not part of the first release.

## 9b. Calls made by the author (not agreed with the owner; please check)

- **Who sets the price:** Tuma publishes the fixed price table for Standard and Overnight by distance band. Shops and riders do not negotiate those tiers. Only Express can float with urgency.
- **Leakage (shops and riders going around Tuma):** the 25c is deducted from float when the rider accepts a job, not when it completes. A delivery code given by the recipient confirms handover. Shop subscriptions (section 5) give shops a reason to stay on the platform. This still needs testing in the pilot.
- **Sequence:** Harare first, Zambia (Lusaka) after Harare proves out. The Lusaka price data exists but there is no suburb list yet.
- **Currency:** prices in US dollars for Harare, Kwacha for Lusaka. Float bought by mobile money.
- **Pilot pass/fail:** to be set before the pilot. Proposed measures: parcels per run and rider earnings per day.

## 9c. Parcel security (owner request, 9 Nov 2026)

The owner asked for four layers of security, modelled on how large couriers such as Royal Mail track parcels: shop owner (sender), courier (rider), Tuma (service provider), parcel owner (recipient). Core rule: no parcel changes hands without two confirmations, one from each side. Tool choices are the author's to make (owner delegated them); tools are not yet picked.

Threats the owner wants covered: (a) a rider stealing a parcel, (b) a parcel going to the wrong person, (c) a shop sending something it should not, (d) false claims against riders.

| Threat | Shop owner | Courier | Tuma | Parcel owner |
|---|---|---|---|---|
| Rider steals parcel | Photo of sealed parcel, numbered tamper tape, declared value | Verified ID and photo, guarantor, scan at pickup, GPS trail | Float held as deposit, off-route and delay alerts, suspension | Tracking link shows progress and expected time |
| Wrong person receives | Confirms recipient name and phone | Delivers only to code holder | Code is one-time and tied to that parcel | Gives the code only after seeing the parcel intact |
| Shop sends something it should not | Declares contents and value, accepts the rules | Can refuse a parcel and report it | Verified shops only, banned-items list, value limits, spot checks | Can report unexpected contents |
| False claims against riders | Photo of the sealed parcel before pickup | Photo and scan at each handover | Keeps the time-stamped record and settles disputes | Delivery code and photo prove receipt |

High-value parcels add an ID check and a second photo, and possibly insurance.

Liability rule (owner, 9 Nov 2026): if a parcel is lost, the person who gave the last signature is liable. In the app a "signature" is a scan plus confirmation or the delivery code. So the shop is liable until the rider confirms pickup, the rider is liable from pickup until the recipient confirms with the delivery code, and the recipient is responsible after that.

Consequences the author sees (not yet discussed with the owner):
- The rider carries the whole risk of the trip, so the pickup check and the sealed-parcel photo matter a lot.
- A rider may not be able to repay a high-value loss. A cap on the parcel value a rider can carry, or insurance above that value, is needed. Open: the cap.
- Disputes turn on the exact moment of handover, so every handover needs a time-stamped confirmation and photo.
- Tuma's own role in claims (arbitration, paying small losses) is still open.

Rider tiers (owner agreed to a value cap that rises with rider level, 9 Nov 2026; the numbers below are the author's placeholders and the owner sets the real ones):

| Rider level | Max parcel value | How a rider gets there |
|---|---|---|
| New | $30 | Verified ID, photo, guarantor, and a $20 deposit |
| Trusted | $100 | 30 clean deliveries and a good rating |
| Senior | $300 | 100 clean deliveries and a larger deposit |
| Above that | Insured only | The shop pays for insurance |

Supporting rules (author's proposal, not yet confirmed):
- Shops see the limit before booking and choose a rider level or insure the parcel.
- Losses below the cap come from the rider's deposit. If that is not enough, Tuma absorbs a small amount and removes the rider from the platform.
- A rider may refuse a parcel whose contents do not match the declared value.
- The shop declares the value and Tuma may spot-check it.

## 10. Unconfirmed items to check

- Distances and placement of each Harare suburb (especially Plymouth).
- The kwacha-dollar rate used.
- Yango's actual commission in each country.
- Whether the 2016 Mukuru-EcoCash link works today (only relevant if the earlier idea returns).
- Running costs: none have been quoted.
- Whether holding rider float (prepaid balances) counts as stored value and needs a payments licence or a partner such as a mobile money operator or bank.
