# cert-items-automatic-approval-axa

SaaS connector for SailPoint Identity Security Cloud (ISC). It pre-approves certification campaign items according to mandatory-role and recertification rules.

This document is the functional and technical specification. It is written so that a SailPoint customer, partner, pre-sales engineer, or an AI coding assistant (for example Cursor) can understand, invoke, and extend the connector without reading the TypeScript implementation first.

## What it does

The connector exposes a single custom command: `campaign:pre-approve`.

Given a **campaign id**, it:

1. Loads every identity certification of that campaign and every pending review item.
2. Pre-approves **mandatory matrix roles** (`type = ROLE` and `revocable = false`).
3. For remaining **recertified** access (`newAccess = false`), looks up the identity population, then the identity's last signed certification outside the current campaign, and pre-approves the same access only if it was already approved or acknowledged there.
4. Optionally requests ISC AI recommendations in configurable batches. By default, `NO` vetoes a business-rule approval. `YES` can approve an item not covered by business rules. `MAYBE` / `NOT_FOUND` / missing recommendations leave business rules unchanged. `businessRulesOverrideAiNo` disables the `NO` veto when a business rule already applies.
5. Reuses that same previous certification to protect access it revoked from AI-only approval, unless explicitly configured otherwise. The history of an identity is read **once**: no previous certification means no second search.
6. Submits decisions to ISC in batches of 50. If a batch is rejected (for example self-certification), it retries one item at a time and continues with the rest of the campaign.
7. Returns totals. When `debug` is enabled, it also returns the full log trail.

The connector does **not** sign off certifications, close campaigns, or lock reviewers. A delegated administrator can still change a pre-approved item until the campaign is closed. Access requests are **not** used as a source of truth: a right revoked in the last campaign and later granted again by an access request stays `newAccess = false` but is **not** auto-approved.

## Functional specifications

### Populations

Two populations are supported: **employee** and **contractor**.

| Config key                    | Meaning                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `populationIdentityAttribute` | Technical name of the identity attribute that stores the population |
| `employeePopulationValues`    | Attribute values that map to employee                               |
| `contractorPopulationValues`  | Attribute values that map to contractor                             |

The identity is loaded with `GET /identities/{id}`. The attribute is read from `attributes`. Comparison is case-insensitive and accent-insensitive (`Employé` matches `employé`). Multi-valued attributes match if any value is in the list.

Unknown population: no history-based pre-approval. Mandatory roles can still be approved, and the revocations of the previous certification still guard AI approvals.

Each population has its own:

-   maximum age of the previous certification, in months
-   list of mobility identity attributes (empty list = mobility is ignored)

### Decision algorithm

Before evaluating items, the connector resolves the previous certification of every identity that has at least one recertified, revocable item. This is the **only** history lookup of the run:

```
For each identity with recertified access:
    Read Identity History once
    PREVIOUS_CERTIFICATION = latest IdentityCertified outside the current campaign
    IF none
        no pre-approval from history, and no revocation guard: nothing is searched again
    ELSE
        Fetch its items once (shared across identities of the same certification)
        APPROVED_KEYS = type:id decided APPROVE or ACKNOWLEDGE for this identity
        REVOKED_KEYS  = type:id decided REVOKE for this identity
        ELIGIBLE = population known AND certification within max age AND no mobility since
```

`APPROVED_KEYS` are used only when `ELIGIBLE` is true. `REVOKED_KEYS` always apply, so a certification discarded because it is too old, because of a mobility, or because the population is unknown still blocks an AI-only approval of the access it revoked.

Business rules are then evaluated first for each pending item (`id` present and `completed` is not true). When AI is enabled, it acts as a veto and/or a fallback:

```
Compute BUSINESS_CANDIDATE:
IF access type is ROLE AND role.revocable is false
    BUSINESS_CANDIDATE = mandatory matrix approval
ELSE IF newAccess is false
    IF PREVIOUS_CERTIFICATION is ELIGIBLE AND type:id is in APPROVED_KEYS
        BUSINESS_CANDIDATE = previous campaign approval

IF AI recommendations are disabled
    APPROVE BUSINESS_CANDIDATE if present, otherwise leave to reviewer

IF AI recommendation = NO
    IF BUSINESS_CANDIDATE exists AND businessRulesOverrideAiNo is true
        APPROVE BUSINESS_CANDIDATE (business reason and comment are kept)
    ELSE
        leave to reviewer  (default: even if BUSINESS_CANDIDATE exists)

IF AI recommendation = MAYBE, NOT_FOUND, missing, or the recommendation API failed
    APPROVE BUSINESS_CANDIDATE if present, otherwise leave to reviewer

IF AI recommendation = YES AND BUSINESS_CANDIDATE exists
    APPROVE BUSINESS_CANDIDATE (business reason and comment are kept)

IF AI recommendation = YES AND no BUSINESS_CANDIDATE
    IF type:id is in REVOKED_KEYS AND approveAiRecommendedPreviouslyRevoked is false
        leave to reviewer
    ELSE
        APPROVE
        comment = "Pré-validation automatique car accès recommandé
                   par le moteur AI de SailPoint"
```

`businessRulesOverrideAiNo` only bypasses a `NO` when a business rule already applies (mandatory role, previous campaign, or mobility mini-campaign). It does not approve an item that has no business candidate. A `NO` on such an item still leaves the decision to the reviewer.

Recommendations are requested once per unique `{identityId, accessType, accessId}` and sent in batches (`aiRecommendationBatchSize`, default 50). Supported types are `ENTITLEMENT`, `ACCESS_PROFILE`, and `ROLE`. The recommendations endpoint is experimental and the `X-SailPoint-Experimental: true` header is sent explicitly.

The answer is read from `responses` **or** `response`: ISC returns `responses` (plural) while the SDK type declares `response` (singular), so reading only the SDK field silently discards every recommendation.

A response entry is matched to its request by the request the API echoes back. When the echo is missing, entries are paired with the requests of the batch **by order**, and only if the response has exactly one entry per request sent; otherwise nothing is mapped, so a partial or reordered response can never be attributed to the wrong access. With `debug` enabled, each batch logs how many requests were sent, how many responses came back, and how many recommendations could be mapped, plus the first 500 characters of the payload when a batch maps nothing. If no recommendation at all could be mapped while the feature is enabled, a WARN is logged even without `debug`.

### Mobility and mini-campaigns

Identity History does not link an `AttributesChanged` event to a certification. The connector uses a **campaign naming convention**:

-   If the previous certification's **campaign name** starts with `Mini Certification Mobilité:`, it is a mobility mini-campaign.
-   Mobility **after** any kept certification (annual or mini) always vetoes history-based pre-approval: there was no certification in between.
-   Mobility **before** a mini-campaign is used only to date the comment, not to veto that mini-campaign.

Older mobility campaigns that do not use the prefix are treated as annual campaigns.

### Resilience

-   A certification that cannot be read or processed is skipped; the campaign continues.
-   An identity whose previous certification cannot be read loses history-based pre-approval, and AI-only approval is disabled for it because its past revocations are unknown.
-   `makeIdentityDecision` is called with up to 50 decisions. On HTTP error, each decision is retried alone.

### Logging

| `debug`           | Logger                    | Command output                                                                          |
| ----------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| `false` (default) | One INFO line with totals | `{ campaignId, totals }` only                                                           |
| `true`            | Every processing step      | Totals plus `certifications`, `submitted`, `failed`, `loggedEvents`, `logCsvPath`       |

The log trail itself is **not** returned in the command output: on a large campaign it reaches hundreds of kilobytes, and the caller often closes the connection before the response is written (`ERR_STREAM_PREMATURE_CLOSE`). The response carries `loggedEvents` (how many entries were recorded) and `logCsvPath`; the entries themselves are in the CSV and in the logger output.

`totals`:

| Field                              | Meaning                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `itemsProcessed`                   | Pending items (`id` set, not completed) in certifications that have an id |
| `approvedAsMandatory`              | Decisions actually submitted as irrevocable roles                         |
| `approvedFromPreviousCampaign`     | Decisions submitted from an annual (or unprefixed) previous campaign      |
| `approvedFromMobilityMiniCampaign` | Decisions submitted from a campaign named `Mini Certification Mobilité:…` |
| `approvedFromAiRecommendation`     | Decisions submitted only because the ISC AI recommendation was `YES`      |

Counts are **submitted successfully**, not merely selected. A 400 on one item is not counted as approved.

When `debug` is true and the process can write to disk, a CSV is also written under `logs/`.

## Technical specifications

### Runtime and SDKs

| Package                    | Role                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@sailpoint/connector-sdk` | Connector host: `createConnector`, `readConfig`, `logger`, `ConnectorError`                                        |
| `sailpoint-api-client`     | ISC REST client (`CertificationsApi`, `IdentitiesApi`, `IdentityHistoryApi`, `IAIRecommendationsApi`, `Paginator`) |

Entry point: `src/index.ts` exports `connector`. Command handler: `campaign:pre-approve`. Business logic: `src/my-client.ts` class `MyClient`.

OAuth: client credentials against `{baseurl}/oauth/token`.

Identity History and IAI Recommendations are **experimental** APIs. Two things are required, and both are mandatory:

-   the `X-SailPoint-Experimental: true` header, which comes from the `xSailPointExperimental` request parameter (the generated client defaults it to `'true'`; the connector passes it explicitly on `getHistoricalIdentityEventsV1` and `getRecommendationsV1`);
-   `configuration.experimental = true` on the `Configuration` object. This is a **client-side gate**: `createRequestFunction` throws `You are using Experimental APIs. Set configuration.experimental = True to enable these APIs in the SDK.` before sending any request that carries the header. Without it, every identity history and recommendation call fails locally, without ever reaching ISC.

When the flag is set, the SDK also prints `Warning: You are using Experimental APIs` on each such call. That message is expected and harmless.

### ISC APIs used

TypeScript method names are those of `sailpoint-api-client` v2 (`…V1` suffix). HTTP paths are the ISC certifications / identities / identity-history APIs.

| SDK class               | Method                            | HTTP                                                        | Why                                                                               | Documentation                                                                                                         | SDK Methods                                                                                                                           |
| ----------------------- | --------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `CertificationsApi`     | `listIdentityCertificationsV1`    | `GET /certifications?filters=campaign.id eq "{campaignId}"` | All certifications of the campaign                                                | [List identity certifications](https://developer.sailpoint.com/docs/api/v2025/list-identity-certifications)           | https://developer.sailpoint.com/docs/tools/sdk/typescript/certifications/methods/certifications#list-identity-certifications-v1       |
| `CertificationsApi`     | `listIdentityAccessReviewItemsV1` | `GET /certifications/{id}/access-review-items`              | Current campaign items, and items of the previous certification used as reference | [List identity access review items](https://developer.sailpoint.com/docs/api/v2025/list-identity-access-review-items) | https://developer.sailpoint.com/docs/tools/sdk/typescript/certifications/methods/certifications#list-identity-access-review-items-v1  |
| `CertificationsApi`     | `getIdentityCertificationV1`      | `GET /certifications/{id}`                                  | Campaign name of the previous certification (mini-campaign prefix)                | [Get identity certification](https://developer.sailpoint.com/docs/api/v2025/get-identity-certification)               | https://developer.sailpoint.com/docs/tools/sdk/typescript/certifications/methods/certifications#get-identity-certification-v1         |
| `CertificationsApi`     | `makeIdentityDecisionV1`          | `POST /certifications/{id}/decide`                          | Submit `APPROVE` decisions                                                        | [Make identity decision](https://developer.sailpoint.com/docs/api/v2025/make-identity-decision)                       | https://developer.sailpoint.com/docs/tools/sdk/typescript/certifications/methods/certifications#make-identity-decision-v1             |
| `IdentitiesApi`         | `getIdentityV1`                   | `GET /identities/{id}`                                      | Population attribute                                                              | [Get identity](https://developer.sailpoint.com/docs/api/v2025/get-identity)                                           | https://developer.sailpoint.com/docs/tools/sdk/typescript/identities/methods/identities#get-identity-v1                               |
| `IdentityHistoryApi`    | `getHistoricalIdentityEventsV1`   | `GET /historical-identities/{id}/events`                    | `IdentityCertified` and `AttributesChanged`                                       | [List identity history events](https://developer.sailpoint.com/docs/api/v2025/list-identity-history-events)           | https://developer.sailpoint.com/docs/tools/sdk/typescript/identity_history/methods/identity-history#get-historical-identity-events-v1 |
| `IAIRecommendationsApi` | `getRecommendationsV1`            | `POST /recommendations/v1/request`                          | Batch AI recommendation (`YES`, `NO`, `MAYBE`, `NOT_FOUND`)                       | [IAI Recommendations](https://developer.sailpoint.com/docs/api/get-recommendations-v-1)                               | https://developer.sailpoint.com/docs/tools/sdk/typescript/iai_recommendations/methods/iai-recommendations#get-recommendations-v1      |
| `Paginator`             | `paginate`                        | Follows `limit` / `offset`                                  | All list calls above                                                              | [TypeScript SDK pagination](https://developer.sailpoint.com/docs/tools/sdk/typescript)                                |

Related platform docs:

-   [TypeScript SDK](https://developer.sailpoint.com/docs/tools/sdk/typescript)
-   [SaaS Connectivity](https://developer.sailpoint.com/docs/connectivity/saas-connectivity)
-   [Custom commands](https://developer.sailpoint.com/docs/connectivity/saas-connectivity/custom-connectors)

History events filtered with `eventTypes`: `IdentityCertified`, `AttributesChanged`. Certification date: `signedDate` then `dateTime`. Mobility: `attributeChanges[].name` compared to the population mobility list; previous/new values are `previousValue` / `newValue`.

Access match key: `{type}:{id}`. ISC does not always fill `accessSummary.access`: on a real campaign, a large share of items carry the id and the name only in the type-specific sub-object. The type and the id are therefore read from `accessSummary.access` first, then from `accessSummary.entitlement`, `accessSummary.accessProfile`, or `accessSummary.role`. The same resolution is applied to the current campaign, to the previous certification, and to the recommendation requests, so the three always agree.

### Project layout

```
src/index.ts              Command registration
src/my-client.ts          Decision engine and ISC calls
src/index.spec.ts         Command wiring tests
src/my-client.spec.ts     Rule and resilience tests
connector-spec.json       Source UI fields and command list
```

## Configuration parameters

All values are passed in the invoke `config` object (and declared in `connector-spec.json` for a source form). Custom command `/invoke` does **not** automatically inject source `connectorAttributes`; copy them into `config`.

| Key                                           | Type        | Required | Default                        | Description                                               |
| --------------------------------------------- | ----------- | -------- | ------------------------------ | --------------------------------------------------------- |
| `baseurl`                                     | string      | yes      |                                | ISC API host, e.g. `https://{tenant}.api.identitynow.com` |
| `clientId`                                    | string      | yes      |                                | PAT or OAuth client id                                    |
| `clientSecret`                                | secret      | yes      |                                | PAT or OAuth client secret                                |
| `debug`                                       | boolean     | no       | `false`                        | Full logs in logger and command output                    |
| `populationIdentityAttribute`                 | string      | yes      | `population`                   | Identity attribute technical name                         |
| `employeePopulationValues`                    | string[]    | yes      | `["employé","employee"]`       | Values = employee                                         |
| `contractorPopulationValues`                  | string[]    | yes      | `["prestataire","contractor"]` | Values = contractor                                       |
| `employeeMaxPreviousCertificationAgeMonths`   | integer > 0 | yes      | `12`                           | Max age of last cert for employees                        |
| `employeeMobilityIdentityAttributes`          | string[]    | no       | `[]`                           | Employee mobility attributes                              |
| `contractorMaxPreviousCertificationAgeMonths` | integer > 0 | yes      | `12`                           | Max age of last cert for contractors                      |
| `contractorMobilityIdentityAttributes`        | string[]    | no       | `[]`                           | Contractor mobility attributes; empty = no mobility veto  |
| `enableAiRecommendations`                     | boolean     | no       | `false`                        | Enable ISC AI recommendation filtering and fallback       |
| `businessRulesOverrideAiNo`                   | boolean     | no       | `false`                        | If true, approve when a business rule applies even if AI returns `NO` |
| `approveAiRecommendedPreviouslyRevoked`       | boolean     | no       | `false`                        | Allow AI `YES` to override a previous `REVOKE`            |
| `aiRecommendationBatchSize`                   | integer > 0 | no       | `50`                           | Identity/access pairs per recommendation API request      |

Command input:

| Key  | Type   | Required | Description                             |
| ---- | ------ | -------- | --------------------------------------- |
| `id` | string | yes      | **Campaign** id, not a certification id |

## How to invoke

`campaign:pre-approve` is not started by aggregation or Test Connection. Call it with `/invoke` (or `sail conn invoke` / local `spcx`).

### Local

```bash
npm install
npm run build
npm run dev
```

POST the JSON body to the port printed by `spcx`:

```json
{
    "type": "campaign:pre-approve",
    "input": {
        "id": "<campaignId>"
    },
    "config": {
        "baseurl": "https://<tenant>.api.identitynow.com",
        "clientId": "<client-id>",
        "clientSecret": "<client-secret>",
        "debug": false,
        "populationIdentityAttribute": "employeeType",
        "employeePopulationValues": ["employé", "employee"],
        "contractorPopulationValues": ["prestataire", "contractor"],
        "employeeMaxPreviousCertificationAgeMonths": 12,
        "employeeMobilityIdentityAttributes": ["costCenter", "department", "situationCode"],
        "contractorMaxPreviousCertificationAgeMonths": 12,
        "contractorMobilityIdentityAttributes": [],
        "enableAiRecommendations": true,
        "businessRulesOverrideAiNo": false,
        "approveAiRecommendedPreviouslyRevoked": false,
        "aiRecommendationBatchSize": 50
    }
}
```

Example:

```bash
curl -sS --max-time 900 -X POST 'http://localhost:<port>/' \
  -H 'Content-Type: application/json' \
  -d @payload.json
```

A campaign with a few thousand items takes minutes: every identity history lookup and every recommendation batch is a sequential API call. Give the client a generous timeout. If it gives up first, the connector still finishes its work and writes the CSV, but `spcx` fails to write the answer and logs `Error [ERR_STREAM_PREMATURE_CLOSE]: Premature close`. That message means the caller disconnected, not that the pre-approval failed.

### Output without debug

```json
{
    "campaignId": "2c9180...",
    "totals": {
        "itemsProcessed": 120,
        "approvedAsMandatory": 40,
        "approvedFromPreviousCampaign": 25,
        "approvedFromMobilityMiniCampaign": 8,
        "approvedFromAiRecommendation": 12
    }
}
```

### Output with `"debug": true`

Same `totals`, plus `certifications` (submitted items, ISC errors, skipped certifications), `submitted`, `failed`, `loggedEvents`, and `logCsvPath` when a local CSV could be written. The individual log entries are only in the CSV and in the logger output.

### ISC

1. `npm run pack-zip` and upload the connector.
2. Create a source and fill the form (including Debug).
3. Invoke the custom command with the same `type` / `input` / `config`. Source form values are not applied unless you copy them into `config`.

Token needs rights to list/decide certifications, read identities, read identity history (`idn:identity-history:read` or equivalent), and call IAI Recommendations when enabled. The recommendation API is experimental and requires `X-SailPoint-Experimental: true`.

## Build and test

```bash
npm test
npm run build
```

Unit tests cover population/age/mobility veto, mini-campaign comments, revoked-then-requested access, the single history lookup that yields both approved and revoked access, AI `YES`/`NO`/no-recommendation behavior, `businessRulesOverrideAiNo`, configurable revoked-access override, batch 400 replay, and skipped certifications.

## Conventions the tenant must follow

-   Mini-campaigns created after a mobility must be named with prefix `Mini Certification Mobilité:` (on the **campaign** name).
-   Mandatory matrix roles must be ISC roles with `revocable = false`.
-   Population values in ISC must appear in `employeePopulationValues` or `contractorPopulationValues`.
