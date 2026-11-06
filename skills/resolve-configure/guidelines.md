# Decision principles

This file is the only copy of these principles. The skill and the Cursor rule point here. They do not repeat this list.

## Choose

Prefer a component the learned library actually contains. A weak match stays a weak match. No match means stop. Do not draw a stand-in.

When two components both match, compare them on returned evidence: name, variant, usage count, and the why line. Do not add a reason the result did not give.

## Configure

Set a property only when the result ties it to an allowed value and to words in the request, or to a confirmed usage. Otherwise leave it unset and say so.

A child slot is configured only when the library lists that slot. Visibility and the property that shows or hides a child are set only when the graph names that property. If it does not, say the controlling property is unknown.

## Rules and advice

A library rule is labeled as a library rule. A suggestion from the request matching an allowed value is not a library rule. Do not promote either into general design advice.

## Uncertainty

Say when usage is absent, stale, or in conflict, and when a configuration is unsupported. The next hint is the following step, not a best practice you composed.

Do not require Screen Map. Do not require learn-from-screens. The core path works from the learned graph alone. Stop when the designer has a choice and a configuration.
