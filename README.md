# Certification Items Automatic Approval

SaaS connector for SailPoint Identity Security Cloud (ISC). It pre-approves certification campaign items using independently configurable business rules and SailPoint AI recommendations.

## Features

The connector exposes one custom command: `campaign:pre-approve`.

For a campaign id, it:

1. Loads all identity certifications and pending review items in the campaign.
2. Optionally approves non-revocable roles.
3. Optionally approves recertified access that was approved in the identity's latest signed certification, provided that certification is within the configured age window.
4. Optionally uses SailPoint AI recommendations as an approval source and as a veto for business-rule approvals.
5. Submits decisions in batches of 50. If ISC rejects a batch, it retries each decision individually so one invalid item does not block the others.

The connector does not sign certifications, close campaigns, or lock reviewers.

There is no population-specific logic, identity-attribute change rule, or campaign naming convention. Every identity uses the same previous-certification age window.

## How a decision is made

Each pending item is evaluated in this **priority order**. The first matching rule wins, and later rules are not used to change the comment or the reason.

1. **Non-revocable roles** (`autoApproveIrrevocableRoles`) — a **business rule**.
2. **Access already approved in a previous certification** (`autoApprovePreviouslyApprovedAccess`) — a **business rule**.
3. **SailPoint AI recommendation** (`autoApproveAiRecommendedAccess`) — used only when no business rule selected the item.

Two extra options then apply:

-   `businessRulesOverrideAiNo`: by default, an AI `NO` **blocks** even a business-rule approval. When this option is enabled, a business-rule approval still goes through despite an AI `NO`. It never creates an approval on its own.
-   `approveAiRecommendedPreviouslyRevoked`: by default, an AI `YES` **cannot** approve access that was revoked in the last signed certification. When this option is enabled, that AI approval is allowed. It has no effect on business-rule approvals.

Each rule can be turned off independently. A disabled rule is simply skipped.

### Examples

These examples assume the usual defaults: both business rules on, AI off, previous certification valid for 12 months.

**A mandatory application role is in the campaign.**  
The role cannot be revoked in ISC. The connector approves it as a non-revocable role. The reviewer does not need to look at it.

**The same VPN access was already approved 8 months ago.**  
Nothing else has changed for this recertified access. The connector approves it because the previous certification is still inside the 12-month window.

**The same VPN access was approved 18 months ago.**  
The previous certification is too old. The connector leaves it to the reviewer, even though the access looks unchanged.

**A new access appears, and AI is not enabled.**  
No business rule applies (it is not a non-revocable role, and it was not approved in a recent campaign). The connector leaves it to the reviewer.

With AI enabled (`autoApproveAiRecommendedAccess`):

**A new access is recommended by SailPoint AI (`YES`).**  
No business rule applies, so the AI rule can approve it. The comment explains that SailPoint AI recommended the access.

**Last year this access was revoked. This year AI still recommends `YES`.**  
By default the connector does **not** auto-approve it: a previous revocation is treated as a warning that a human should review. Turn on `approveAiRecommendedPreviouslyRevoked` only if you want AI to approve those cases anyway.

**A non-revocable role (or a recently re-approved access) gets an AI `NO`.**  
By default the connector **stops** and leaves the item to the reviewer: AI is allowed to veto a business-rule approval. If `businessRulesOverrideAiNo` is enabled, the business rule still wins and the item is approved with the **business** comment, not an AI comment.

**A non-revocable role also gets an AI `YES`.**  
The business rule already selected it. AI is not used as the reason: the comment stays that this is a birthright / mandatory role and can only be acknowledged.

## Approval rules

### Non-revocable roles

When `autoApproveIrrevocableRoles` is enabled, a pending item is approved when:

-   its access type is `ROLE`; and
-   `accessSummary.role.revocable` is `false`.

Default: enabled.

### Access approved in the previous certification

When `autoApprovePreviouslyApprovedAccess` is enabled, the connector:

1. Finds the identity's latest `IdentityCertified` event outside the current campaign.
2. Checks that its signed date is no older than `maxPreviousCertificationAgeMonths`.
3. Loads that certification's items.
4. Approves a current recertified item (`newAccess = false`) only when the same `{type}:{id}` was previously decided `APPROVE` or `ACKNOWLEDGE`.

Default: enabled, with a 12-month window.

Only the latest previous signed certification is considered. An access request is not treated as proof of a previous approval.

### AI-recommended access

When `autoApproveAiRecommendedAccess` is enabled, recommendations work as follows. See [How a decision is made](#how-a-decision-is-made) for the priority versus business rules.

-   `YES`: approves an item **not** already selected by a business rule.
-   `NO`: by default, prevents approval — including a business-rule approval — unless `businessRulesOverrideAiNo` is enabled.
-   `MAYBE`, `NOT_FOUND`, a missing recommendation, or a failed recommendation request: leaves the business-rule result unchanged.

By default, an AI `YES` cannot approve access revoked in the identity's latest signed certification. Set `approveAiRecommendedPreviouslyRevoked` to `true` to allow it.

Recommendations are deduplicated by `{identityId, accessType, accessId}` and requested in configurable batches. Supported access types are `ENTITLEMENT`, `ACCESS_PROFILE`, and `ROLE`.

## Decision comments

All comments submitted to ISC are in English:

-   `Automatically approved because this is a birthright / mandatory role and can only be acknowledged`
-   `Automatically approved because this access was approved in the previous certification signed on YYYY-MM-DD`
-   `Automatically approved because SailPoint AI recommended this access`
-   `Automatically approved by SailPoint AI despite being revoked in the previous certification`

## Configuration

| Key                                     | Type        | Required | Default | Description                                                               |
| --------------------------------------- | ----------- | -------- | ------- | ------------------------------------------------------------------------- |
| `baseurl`                               | string      | yes      |         | ISC API URL, for example `https://{tenant}.api.identitynow.com`           |
| `clientId`                              | string      | yes      |         | PAT or OAuth client id                                                    |
| `clientSecret`                          | secret      | yes      |         | PAT or OAuth client secret                                                |
| `debug`                                 | boolean     | no       | `false` | Return execution details and write a CSV log                              |
| `autoApproveIrrevocableRoles`           | boolean     | no       | `true`  | Enable automatic approval of non-revocable roles                          |
| `autoApprovePreviouslyApprovedAccess`   | boolean     | no       | `true`  | Enable automatic approval based on the latest signed certification        |
| `maxPreviousCertificationAgeMonths`     | integer > 0 | no       | `12`    | Maximum age of the certification used by the previous-approval rule       |
| `autoApproveAiRecommendedAccess`        | boolean     | no       | `false` | Enable automatic approval and filtering from SailPoint AI recommendations |
| `businessRulesOverrideAiNo`             | boolean     | no       | `false` | Allow active business rules to override an AI `NO`                        |
| `approveAiRecommendedPreviouslyRevoked` | boolean     | no       | `false` | Allow AI `YES` to approve access revoked in the latest certification      |
| `aiRecommendationBatchSize`             | integer > 0 | no       | `50`    | Identity/access pairs per recommendation request                          |

`autoApproveAiRecommendedAccess` replaces the former `enableAiRecommendations` key.

## Command input

The command expects a campaign id, not a certification id:

```json
{
    "type": "campaign:pre-approve",
    "input": {
        "id": "<campaign-id>"
    },
    "config": {
        "baseurl": "https://<tenant>.api.identitynow.com",
        "clientId": "<client-id>",
        "clientSecret": "<client-secret>",
        "debug": false,
        "autoApproveIrrevocableRoles": true,
        "autoApprovePreviouslyApprovedAccess": true,
        "maxPreviousCertificationAgeMonths": 12,
        "autoApproveAiRecommendedAccess": false,
        "businessRulesOverrideAiNo": false,
        "approveAiRecommendedPreviouslyRevoked": false,
        "aiRecommendationBatchSize": 50
    }
}
```

Custom command invocation does not automatically inject source `connectorAttributes`; include the source configuration in the invoke `config` object.

## Output

Without debug:

```json
{
    "campaignId": "2c9180...",
    "totals": {
        "itemsProcessed": 120,
        "approvedAsIrrevocableRole": 40,
        "approvedFromPreviousCampaign": 25,
        "approvedFromAiRecommendation": 12
    }
}
```

Counts include only decisions successfully submitted to ISC.

With `debug: true`, the response also includes certification results, submitted and failed counts, the number of logged events, and the CSV log path. Detailed log entries are kept in the CSV and logger output rather than returned inline.

## ISC APIs

The connector uses:

-   Certifications APIs to list certifications and review items, read previous decisions, and submit approvals.
-   Identity History API to find the latest previous signed certification.
-   IAI Recommendations API when AI approval is enabled.

Identity History and IAI Recommendations are experimental APIs. The connector enables experimental SDK support and sends `X-SailPoint-Experimental: true`.

The token needs permission to list and decide certifications, read identity history, and call IAI Recommendations when enabled.

## Local development

```bash
npm install
npm test
npm run build
```

Run the local connector:

```bash
npm run dev
```

Then invoke the URL printed by `spcx`:

```bash
curl -sS --max-time 900 -X POST 'http://localhost:<port>/' \
  -H 'Content-Type: application/json' \
  -d @payload.json
```

Large campaigns can take several minutes because history and recommendation requests are sequential. Use a sufficiently long client timeout.

## Project layout

```text
src/index.ts          Command registration
src/my-client.ts      Approval rules and ISC API calls
src/index.spec.ts     Command wiring tests
src/my-client.spec.ts Rule and resilience tests
connector-spec.json   Source configuration form
```
