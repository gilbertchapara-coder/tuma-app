# Tuma App (Harare Pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first release of Tuma: shops book parcels, riders accept pooled runs, every handover is confirmed, and recipients get a tracking link and a one-time delivery code, for one Harare corridor.

**Architecture:** Business rules (prices, runs, rider tiers, liability, delivery codes, float ledger) live in one pure TypeScript package with no I/O, so they are tested first and reused everywhere. A Fastify API with PostgreSQL stores state and enforces those rules. Three thin clients sit on it: an Expo (React Native) Android app for shops and riders, and a Vite web app for the recipient tracking page and the owner's dashboard.

**Tech Stack:** TypeScript, npm workspaces, Vitest, Zod, Fastify, PostgreSQL (via `pg`), Expo React Native, Vite + React.

**Spec:** `C:\Users\odzmt\Desktop\Tuma\2026-11-09-tuma-business-model-design.md` (approved by the owner 9 Nov 2026). Tool choices above are the author's picks; the owner delegated them.

## Global Constraints

- Platform fee: flat 25 cents (US$0.25) per parcel, deducted from rider float **at job acceptance**, not completion. The fee must be a config value (`PLATFORM_FEE_CENTS`, default 25) because Harare may need 15 to 20 cents.
- Money is stored as integer cents. Harare prices are US dollars. Lusaka (kwacha) is out of scope for this plan.
- Service levels: `express` (one parcel, now), `standard` (pooled, same day), `overnight` (pooled, next morning).
- Runs: `north` (Avondale, Avenues, Milton Park), `southwest` (Mbare, Workington, Houghton Park), `south` (Waterfalls, Plymouth). Plymouth's position is unconfirmed, so keep the suburb table in one editable data file.
- Price table (cents), Express / Standard / Overnight: 2 km (Avenues, Milton Park) 200/120/100; 3 km (Mbare) 200/130/110; 4 to 5 km (Avondale, Workington) 250/150/120; 6 to 7 km (Houghton Park) 300/180/150; 8 to 10 km (Waterfalls, Plymouth) 350/200/170.
- Express is a fixed table price in this release. No bidding. (The spec leaves the auction mechanism to the builder.)
- Core rule: no parcel changes hands without two confirmations, one from each side.
- Liability: the last party to confirm is liable. Shop until the rider confirms pickup, rider from pickup until the recipient confirms with the delivery code, recipient after that.
- Rider tiers (value caps, placeholders the owner will set): New $30 (verified ID, photo, guarantor, $20 deposit); Trusted $100 (30 clean deliveries, good rating); Senior $300 (100 clean deliveries, larger deposit); above $300 insured only.
- Losses below the cap come from the rider's deposit first; Tuma may absorb a small amount; the rider is then removed.
- Shops declare parcel contents and value. A rider may refuse a parcel whose contents do not match the declared value.
- First release is small: one corridor, a few riders, Express plus one pooled run, and parcels-per-run visible from day one.
- Pilot caution: keep rider balances small; the float is stored value and the licensing position is unconfirmed. Mobile money top-up sits behind an adapter interface and ships with a fake provider only.
- Out of scope: WhatsApp ordering (later feature), Zambia launch, ads, shop subscriptions, rider insurance partners.
- No generic fonts in any UI (Arial, Inter, Poppins, Calibri, Impact). Use Bricolage Grotesque for headings and Instrument Sans for body.

## Review Focus

1. A recipient (or someone else) guesses the delivery code repeatedly: the code locks after 3 wrong tries and the parcel is flagged, not unlimited guesses. Tested in Task 4.
2. A rider's phone loses signal or dies mid-run: scans made offline queue on the phone and sync later with their original timestamps, so liability is decided by when they happened. Tested in Task 12.
3. Two riders accept the same bundle at the same moment: exactly one wins, the other gets a clear "taken" answer, and only the winner is charged the fee. Tested in Task 8.
4. A shop enters a suburb outside the pilot table, or a declared value of zero, negative or not a whole number of cents: the booking is rejected with a plain message. Tested in Tasks 1 and 8.
5. A shop mistypes the recipient's phone number: the code goes to the wrong person. The shop must re-confirm the number on the booking screen, and the tracking page shows only the last 3 digits. Tested in Task 11.

---

## File Structure

```
C:\Users\odzmt\Desktop\Tuma\app\
  package.json                      workspaces: packages/*, apps/*
  packages/core/src/
    suburbs.ts                      suburb -> band, run (data only)
    pricing.ts                      price and fee
    custody.ts                      parcel events, state, liable party
    tiers.ts                        rider tier and value cap
    deliveryCode.ts                 one-time code generate/verify/lock
    batching.ts                     group parcels into runs
    ledger.ts                       float, deposit, fee, loss
    flags.ts                        off-route and stall flags
  packages/core/test/               one test file per source file
  apps/api/src/                     Fastify server, routes, pg repos, migrations
  apps/web/src/                     recipient tracking page, owner dashboard
  apps/mobile/                      Expo app: shop and rider screens
```

### Task 1: Project scaffold, suburbs and pricing

**Files:**
- Create: `app/package.json`, `app/packages/core/package.json`, `app/packages/core/src/suburbs.ts`, `app/packages/core/src/pricing.ts`
- Test: `app/packages/core/test/pricing.test.ts`

**Interfaces:**
- Produces: `type ServiceLevel = 'express'|'standard'|'overnight'`; `type Run = 'north'|'southwest'|'south'`; `SUBURBS: Record<string,{band:string;run:Run}>`; `priceCents(suburb: string, level: ServiceLevel): number` (throws `UnknownSuburbError`); `platformFeeCents(): number` (reads `PLATFORM_FEE_CENTS`, default 25).

- [ ] **Step 1: Write failing tests** in `pricing.test.ts`: `priceCents('Avenues','express') === 200`; `priceCents('Waterfalls','standard') === 200`; `priceCents('Houghton Park','overnight') === 150`; every one of the 8 suburbs returns the table values for all three levels; `priceCents('Borrowdale','express')` throws `UnknownSuburbError`; suburb lookup ignores case and extra spaces; `platformFeeCents() === 25` by default and `15` when `PLATFORM_FEE_CENTS=15`.
- [ ] **Step 2:** Run `npm test -w packages/core`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the data file and functions with the signatures above; init git in `app/`.
- [ ] **Step 4:** Run `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): suburbs and pricing`.

### Task 2: Custody chain and liability

**Files:** Create `packages/core/src/custody.ts`; Test `packages/core/test/custody.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type EventType = 'booked'|'sealed'|'pickup_confirmed'|'in_transit'|'delivered'|'refused_by_rider'|'reported_lost'|'cancelled'`; `interface CustodyEvent { type: EventType; at: string /*ISO*/; actor: 'shop'|'rider'|'recipient'|'tuma'; photoUrl?: string }`; `appendEvent(events: CustodyEvent[], next: CustodyEvent): CustodyEvent[]` (returns a new array, throws `IllegalTransitionError`); `liableParty(events: CustodyEvent[]): 'shop'|'rider'|'recipient'`.

- [ ] **Step 1: Write failing tests**: before `pickup_confirmed`, `liableParty` is `'shop'`; after it, `'rider'`; after `delivered`, `'recipient'`; `delivered` before `pickup_confirmed` throws; `pickup_confirmed` without a prior `sealed` event (with photo) throws; `appendEvent` does not mutate its input; events appended with an earlier `at` than the last one are rejected.
- [ ] **Step 2:** Run the test file. Expected: FAIL.
- [ ] **Step 3:** Implement as a small transition table plus a fold over the events.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): custody chain and liability`.

### Task 3: Rider tiers and value caps

**Files:** Create `packages/core/src/tiers.ts`; Test `packages/core/test/tiers.test.ts`

**Interfaces:**
- Produces: `type Tier = 'unverified'|'new'|'trusted'|'senior'`; `interface RiderStats { verified: boolean; hasGuarantor: boolean; depositCents: number; cleanDeliveries: number; rating: number }`; `riderTier(s: RiderStats): Tier`; `capCents(t: Tier): number` (0, 3000, 10000, 30000); `canCarry(s: RiderStats, valueCents: number, insured: boolean): boolean`.

- [ ] **Step 1: Write failing tests**: verified rider with guarantor and `depositCents: 2000` is `'new'`; the same rider with `depositCents: 1999` is `'unverified'`; 30 clean deliveries and rating 4.0 gives `'trusted'`; 100 clean deliveries, rating 4.0 and `depositCents: 5000` gives `'senior'`; a rider with 29 clean deliveries stays `'new'`; `canCarry(new, 3000, false)` true, `(new, 3001, false)` false; `(senior, 30001, false)` false but `(senior, 30001, true)` true; value 0 or negative returns false. Rating threshold 4.0 and senior deposit 5000 are placeholders defined as named constants.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with exported constants for thresholds so the owner can change them in one place.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): rider tiers`.

### Task 4: One-time delivery code

**Files:** Create `packages/core/src/deliveryCode.ts`; Test `packages/core/test/deliveryCode.test.ts`

**Interfaces:**
- Produces: `interface CodeRecord { hash: string; salt: string; failedAttempts: number; used: boolean; locked: boolean }`; `issueCode(): { code: string; record: CodeRecord }` (6 digits); `checkCode(record: CodeRecord, input: string): { ok: boolean; record: CodeRecord }` (returns a new record).

- [ ] **Step 1: Write failing tests**: `issueCode().code` matches `/^\d{6}$/` and the record never contains the plain code; correct code returns `ok: true` and a record with `used: true`; reusing a used code returns `ok: false`; 3 wrong inputs set `locked: true` and a 4th input with the correct code still returns `ok: false`; wrong input does not mutate the old record.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with `crypto.randomInt`, salted SHA-256, and a constant-time compare.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): delivery code`.

### Task 5: Run batching

**Files:** Create `packages/core/src/batching.ts`; Test `packages/core/test/batching.test.ts`

**Interfaces:**
- Consumes: `Run`, `ServiceLevel`, `SUBURBS` from Task 1.
- Produces: `interface BookedParcel { id: string; suburb: string; level: ServiceLevel; bookedAt: string }`; `interface Bundle { run: Run; level: 'standard'|'overnight'; parcelIds: string[]; dropOrder: string[] /*suburbs, nearest first*/ }`; `bundleRuns(parcels: BookedParcel[], cutoffAt: string): Bundle[]`.

- [ ] **Step 1: Write failing tests**: Express parcels never appear in any bundle; 3 standard parcels to Mbare and Houghton Park booked before the cutoff form one `southwest` bundle with `dropOrder` `['Mbare','Houghton Park']`; a parcel booked after the cutoff is excluded; standard and overnight never share a bundle; parcels for `north` and `south` form separate bundles; an empty list returns `[]`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement by grouping on `(run, level)` and ordering suburbs by band distance.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): run batching`.

### Task 6: Float ledger

**Files:** Create `packages/core/src/ledger.ts`; Test `packages/core/test/ledger.test.ts`

**Interfaces:**
- Consumes: `platformFeeCents` (Task 1).
- Produces: `type EntryType = 'topup'|'fee'|'fee_refund'|'deposit_hold'|'loss_payout'`; `interface Entry { type: EntryType; cents: number; at: string; jobId?: string }`; `balanceCents(entries: Entry[]): number`; `chargeFee(entries: Entry[], jobId: string, at: string): Entry[]` (throws `InsufficientFloatError`); `refundFee(entries: Entry[], jobId: string, at: string): Entry[]` (only if no `pickup_confirmed` yet, enforced by caller).

- [ ] **Step 1: Write failing tests**: top-up of 500 then `chargeFee` leaves 475; `chargeFee` with balance 20 throws and leaves entries unchanged; charging the same `jobId` twice charges once; `refundFee` restores 25; `loss_payout` draws from deposit entries first and the balance never goes below zero; inputs are never mutated.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement append-only entries; balance is a sum.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): float ledger`.

### Task 7: Route flags

**Files:** Create `packages/core/src/flags.ts`; Test `packages/core/test/flags.test.ts`

**Interfaces:**
- Produces: `interface GpsPoint { lat: number; lng: number; at: string }`; `type Flag = 'off_route'|'stalled'|'late'`; `routeFlags(trail: GpsPoint[], plannedStops: {lat:number;lng:number}[], nowIso: string): Flag[]`. Constants: off-route 1.5 km from the planned line, stalled 10 minutes under 20 metres movement, both placeholders.

- [ ] **Step 1: Write failing tests**: a trail on the planned line returns `[]`; a point 2 km away returns `['off_route']`; 12 minutes of near-identical points returns `['stalled']`; an empty trail returns `[]` without throwing; points out of time order are sorted before checking.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement with the haversine distance.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): route flags`.

### Task 8: API and database

**Files:**
- Create: `app/apps/api/src/server.ts`, `app/apps/api/src/routes/{parcels,bundles,riders,codes}.ts`, `app/apps/api/src/repo.ts`, `app/apps/api/migrations/001_init.sql`
- Test: `app/apps/api/test/{parcels,bundles,codes}.test.ts` (run against a real Postgres test database)

**Interfaces:**
- Consumes: everything exported from `packages/core`.
- Produces (HTTP, all bodies validated with Zod): `POST /parcels` body `{ suburb, level, valueCents, contents, recipientPhone, recipientPhoneConfirm }` returns `{ parcelId, priceCents, trackingUrl }`; `POST /bundles/build` (cron/admin) returns `Bundle[]`; `POST /bundles/:id/accept` returns `{ ok: true }` or `409 taken` or `402 insufficient_float` or `403 over_cap`; `POST /parcels/:id/events` body `CustodyEvent` (rider pickup needs the sealed photo); `POST /parcels/:id/deliver` body `{ code }`; `GET /track/:token` returns public status with the phone masked to the last 3 digits.

- [ ] **Step 1: Write failing tests**: booking an unknown suburb returns 422; `valueCents` of 0, -5 or 1.5 returns 422; mismatched `recipientPhone` and `recipientPhoneConfirm` returns 422; two simultaneous `accept` calls produce exactly one 200 and one 409, and exactly one fee entry; accept by a `new` rider on a $31 parcel returns 403; `deliver` with 3 wrong codes locks and the next correct code still fails; `GET /track` never returns the full phone number or the plain code.
- [ ] **Step 2:** Run `npm test -w apps/api`. Expected: FAIL.
- [ ] **Step 3:** Implement routes as thin wrappers over core functions; accept uses a single SQL transaction with `SELECT ... FOR UPDATE` on the bundle row; auth is phone OTP behind an `OtpProvider` interface with a fake provider for tests.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): parcels, bundles, delivery codes`.

### Task 9: Flags, claims and disputes

**Files:** Create `apps/api/src/routes/claims.ts`, `apps/api/src/jobs/flagJob.ts`; Test `apps/api/test/claims.test.ts`

**Interfaces:**
- Consumes: `routeFlags`, `liableParty`, `appendEvent`, `loss_payout` entries.
- Produces: `POST /parcels/:id/report-lost` returns `{ liable: 'shop'|'rider'|'recipient'; payoutCents: number }`; `runFlagJob(now: Date): Promise<number>` stores flags and returns how many were raised.

- [ ] **Step 1: Write failing tests**: a parcel lost after pickup and before delivery names the rider as liable and takes the loss from the rider's deposit first; a parcel lost before rider pickup names the shop and draws nothing from the rider; a loss larger than the rider deposit pays out what exists and marks the rider `removed`; `runFlagJob` raises one flag for a stalled rider and none twice for the same stall.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): claims and flags`.

### Task 10: Recipient tracking page and owner dashboard

**Files:** Create `apps/web/src/{Track.tsx,Dashboard.tsx,main.tsx,styles.css}`; Test `apps/web/test/track.test.tsx`

**Interfaces:**
- Consumes: `GET /track/:token`, `GET /admin/metrics` (add to API in this task: `{ parcelsPerRun: {run,date,count}[]; ridersActive: number; feesCents: number }`).

- [ ] **Step 1: Write failing tests**: the tracking page shows status, run and the masked phone `***123`; it never renders a full phone number or a code; an unknown token shows a plain "we cannot find this parcel" message; the dashboard shows parcels per run per day and flags any run with fewer than 5 parcels.
- [ ] **Step 2:** Run `npm test -w apps/web`. Expected: FAIL.
- [ ] **Step 3:** Implement; fonts per the Global Constraints; layout works at 360 px width on a slow connection (no large images).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): tracking page and dashboard`.

### Task 11: Mobile app, shop flow

**Files:** Create `apps/mobile/src/shop/{BookParcel.tsx,MyParcels.tsx}`; Test `apps/mobile/test/shop.test.tsx`

**Interfaces:**
- Consumes: `POST /parcels`, `GET /parcels?mine=true`.

- [ ] **Step 1: Write failing tests**: the booking form shows the table price as soon as suburb and level are chosen; the shop must type the recipient phone twice and the submit button stays disabled until they match; the form requires contents, value and a photo of the sealed parcel; the price is shown in dollars and cents.
- [ ] **Step 2:** Run `npm test -w apps/mobile`. Expected: FAIL.
- [ ] **Step 3:** Implement screens; labels and error text in plain English, short.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mobile): shop booking`.

### Task 12: Mobile app, rider flow with offline queue

**Files:** Create `apps/mobile/src/rider/{Bundles.tsx,Run.tsx,scanQueue.ts}`; Test `apps/mobile/test/rider.test.tsx`, `apps/mobile/test/scanQueue.test.ts`

**Interfaces:**
- Produces: `enqueueEvent(parcelId: string, e: CustodyEvent): Promise<void>`; `flushQueue(send: (id:string,e:CustodyEvent)=>Promise<void>): Promise<{sent:number;failed:number}>`. Events keep the `at` time they were made, not the time they sync.

- [ ] **Step 1: Write failing tests**: with the network off, a pickup scan is stored and the screen still shows "saved, will send"; `flushQueue` sends queued events in their original order with their original `at`; a failed send stays in the queue and is retried later; a rider with 0 float sees "top up to accept" and not an error code; the screen shows the rider's tier and value cap.
- [ ] **Step 2:** Run `npm test -w apps/mobile`. Expected: FAIL.
- [ ] **Step 3:** Implement; GPS sampled every 60 seconds to save battery and data; photos compressed before upload.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mobile): rider flow and offline queue`.

### Task 13: Float top-up adapter and end-to-end pilot flow

**Files:** Create `apps/api/src/topup/{provider.ts,fakeProvider.ts}`, `apps/api/src/routes/topup.ts`; Test `apps/api/test/e2e.test.ts`

**Interfaces:**
- Produces: `interface TopupProvider { requestTopup(phone: string, cents: number): Promise<{ref:string}>; confirmed(ref: string): Promise<boolean> }`; `POST /riders/me/topup` body `{ cents }`. Maximum single top-up and maximum balance are config values (placeholders $20 and $50) to keep float small during the pilot.

- [ ] **Step 1: Write failing tests**: a top-up above the maximum is refused with a plain message; a confirmed fake top-up adds a `topup` entry; one end-to-end test runs the full flow: shop books 3 Standard parcels to the South-West run, bundle builds, a funded Trusted rider accepts, scans pickup, delivers each parcel with its code, and the final ledger shows 3 x 25 cents of fees and every parcel `delivered` with the rider no longer liable.
- [ ] **Step 2:** Run `npm test -w apps/api`. Expected: FAIL.
- [ ] **Step 3:** Implement the adapter interface and the fake. A real EcoCash or other provider is a later task and is blocked on the licensing decision in the spec (section 7).
- [ ] **Step 4:** Run the whole suite `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit `feat: top-up adapter and pilot flow`.

---

## Self-Review Notes

- **Spec coverage:** pricing and bands (T1), custody and liability (T2), tiers (T3), delivery code (T4), runs and pooling (T5), float and fee at acceptance (T6, T8), anomalies (T7), claims and deposit losses (T9), tracking and parcels-per-run visibility (T10), shop and rider apps (T11, T12), small float cap and licensing caution (T13). Not covered on purpose: WhatsApp ordering, Zambia, ads, subscriptions, insurance partners, real mobile money provider.
- **Open items carried from the spec:** Plymouth's location, tier numbers, who covers losses above the deposit (Tuma "absorbs a small amount": the amount is a config value to set), and licensing. None block the build; each is one config or data change.
