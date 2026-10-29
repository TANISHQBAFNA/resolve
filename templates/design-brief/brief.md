---
ticket: <ticket id>
product: <product name>
journey: [journey-<verb>-<noun>]
ui_scope: true
requirements_source: <path to the requirements document>
status: draft
---

# Design brief: <ticket title>

Fill this in before any screen is drawn. Check it with `resolve brief check <this file>`.
Set `status: complete` when every table below is filled in and every question is answered.
Replace each `<placeholder>`. A row that does not apply says `N/A — <reason>`, never a blank.
Set `ui_scope: false` only for a ticket that changes no screen and no API response or error code a screen reads.

## 1. Journey changes

Only the steps this ticket adds or changes. Point to the product-level journey file; do not copy it.

Journey file: <path to the product journey file>

| Journey id | Step | Change |
| --- | --- | --- |
| journey-<verb>-<noun> | <step name> | <added or changed, and how> |

## 2. Screen inventory

One row per screen and state. States: default, empty, loading, error (one row per named error), success, permission.
A row with no state of its own says `N/A — <reason>`.

| Screen | State | What the user sees and can do |
| --- | --- | --- |
| <screen name> | default | <content and actions> |
| <screen name> | empty | <content and actions> |
| <screen name> | loading | <content and actions> |
| <screen name> | error — <named error> | <content and actions> |
| <screen name> | success | <content and actions> |
| <screen name> | permission | <what a user without the role sees> |

## 3. Content and data

One row per displayed field. Source is an API field, a column, or static copy.
Provenance is `contract` (the API contract says so), `inferred` (read from existing behaviour), or `proposed` (a new endpoint field; this feeds API design).

| Field | Screen | Source | Format | Limits | Provenance |
| --- | --- | --- | --- | --- | --- |
| <field label> | <screen name> | <api field, column or static copy> | <format> | <length, range, N/A — reason> | contract |

## 4. Experience-rule exceptions

Only where this ticket departs from the product's experience rules (`experience-rules.md`). Write `None` if it does not.

None

## 5. Open questions for the product owner

Every question has an owner. The answer is filled in before `status: complete`. Write `None` in the question cell if there are none.

| Question | Owner | Answer |
| --- | --- | --- |
| <question> | <name or role> | <answer> |
