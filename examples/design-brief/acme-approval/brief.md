---
ticket: ACME-1042
product: Acme Pay
journey: [journey-approve-payment]
ui_scope: true
requirements_source: docs/requirements/acme-approvals.md
status: complete
---

# Design brief: Approve a payment (maker/checker)

Check it with `resolve brief check examples/design-brief/acme-approval/brief.md`.

## 1. Journey changes

Journey file: docs/journeys/acme-pay.md

| Journey id | Step | Change |
| --- | --- | --- |
| journey-approve-payment | Review pending payment | Added. A checker opens a payment a maker submitted and sees it read-only. |
| journey-approve-payment | Decide | Added. The checker approves, or rejects with a reason. |

## 2. Screen inventory

| Screen | State | What the user sees and can do |
| --- | --- | --- |
| Pending approvals | default | A table of payments waiting for this checker: payee, amount, maker, submitted date. A row opens the payment. |
| Pending approvals | empty | Message "No payments are waiting for you." No actions. |
| Pending approvals | loading | Table skeleton with the column headers visible. |
| Pending approvals | error — list not available | Inline error with a Retry button. The page title stays. |
| Pending approvals | success | N/A — the list has no submit action, so there is nothing to confirm. |
| Pending approvals | permission | A user without the checker role sees "You do not have access to approvals." and no table. |
| Review payment | default | Payment details read-only, with an Approve button and a Reject button. |
| Review payment | empty | N/A — a payment always has details; a missing one is the not-found error. |
| Review payment | loading | Details skeleton. Approve and Reject are disabled. |
| Review payment | error — payment not found | Message "This payment is no longer waiting for approval." with a Back to approvals link. |
| Review payment | error — already decided | Message naming who decided and when. Approve and Reject are removed. |
| Review payment | success | Confirmation banner "Payment approved" or "Payment rejected", then a Back to approvals link. |
| Review payment | permission | The checker cannot approve a payment they made themselves: the buttons are replaced by the message "You cannot approve your own payment." |
| Reject dialog | default | A required Reason text area and a Confirm rejection button. |
| Reject dialog | empty | N/A — the dialog opens with the Reason field empty by design; the Confirm button stays disabled until it is filled. |
| Reject dialog | loading | Confirm rejection shows a spinner and the dialog cannot be closed. |
| Reject dialog | error — rejection failed | Inline error above the buttons with the reason kept in the field. |
| Reject dialog | success | N/A — the dialog closes and the Review payment success banner is shown. |
| Reject dialog | permission | N/A — the dialog only opens from the Reject button, which a user without permission never sees. |

## 3. Content and data

| Field | Screen | Source | Format | Limits | Provenance |
| --- | --- | --- | --- | --- | --- |
| Payee name | Pending approvals, Review payment | payments.payee_name | Text | Up to 70 characters, truncated with an ellipsis in the table | contract |
| Amount | Pending approvals, Review payment | payments.amount and payments.currency | Currency, two decimals | Up to 15 digits | contract |
| Maker | Pending approvals, Review payment | payments.created_by | Full name | Up to 50 characters | contract |
| Submitted date | Pending approvals | payments.submitted_at | Date, locale short form | N/A — a date has no length limit | contract |
| Decision history | Review payment | decisions list, newest first | Name, decision, time | Last 5 shown | inferred |
| Rejection reason | Reject dialog | Typed by the checker | Plain text | 10 to 500 characters | proposed |
| Approval empty message | Pending approvals | Static copy | Sentence | One line | contract |

## 4. Experience-rule exceptions

None

## 5. Open questions for the product owner

| Question | Owner | Answer |
| --- | --- | --- |
| Can a checker approve a payment above their approval limit? | Product owner | No. The Approve button is disabled with the message "Above your limit" and the payment goes to the next checker. |
| Is a rejection reason shown to the maker? | Product owner | Yes, in the maker's payment history. |
