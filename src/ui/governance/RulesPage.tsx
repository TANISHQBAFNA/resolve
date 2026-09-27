import { useEffect, useMemo, useState } from "react";
import { COMPONENT_DEFINITION_TYPES } from "@/core/model";
import { parseBindRulesFile, ruleLabel, whyLine } from "@/core/query/bindRules";
import { useGraphStore } from "@/state/graphStore";
import exampleRules from "@/data/bind-rules.example.json";

interface GovernancePayload {
  rules: Array<{ id: string; kind: string; label: string; require?: string; requireName?: string }>;
  proposals: Array<{ id: string; status: string; summary: string; evidence: string }>;
  patterns: Array<{ masterId: string; name: string; why: string }>;
  warnings?: Array<{ rule: string; reason: string }>;
  hint: string;
}

const parsedExample = parseBindRulesFile(exampleRules);
const EXAMPLE: GovernancePayload = {
  rules: parsedExample.rules.map((rule) => ({ ...rule, label: ruleLabel(rule) })),
  proposals: [],
  patterns: [],
  hint: "Sample from src/data/bind-rules.example.json. Live file: npm run resolve -- rules. Pending proposals: npm run resolve -- soci. Approve: npm run resolve -- approve <id>.",
};

export function RulesPage() {
  const [data, setData] = useState<GovernancePayload>(EXAMPLE);
  const index = useGraphStore((state) => state.index);
  const [masterId, setMasterId] = useState("");

  useEffect(() => {
    void fetch("/api/governance")
      .then((response) => (response.ok ? response.json() : EXAMPLE))
      .then((payload: GovernancePayload) => {
        setData(payload);
      })
      .catch(() => undefined);
  }, []);

  const masters = useMemo(() => {
    if (!index) return [];
    return index
      .getNodesByType(...COMPONENT_DEFINITION_TYPES)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [index]);

  useEffect(() => {
    if (!masterId && masters[0]) setMasterId(masters[0].id);
  }, [masterId, masters]);

  const pattern = data.patterns.find((row) => row.masterId === masterId);
  const selected = masters.find((node) => node.id === masterId);
  const why =
    pattern?.why ??
    whyLine({
      deprecated: selected?.status === "deprecated",
    });

  const pending = data.proposals.filter((row) => row.status === "pending");

  return (
    <div className="rules-page">
      <header className="rules-page__intro">
        <h2>Rules</h2>
        <p>
          Human-authored bind rules. Agents recommend and verify against them. Rules never change by
          themselves.
        </p>
        <p className="muted">{data.hint}</p>
        {data.warnings && data.warnings.length > 0 ? (
          <ul className="rules-page__warnings">
            {data.warnings.map((warning) => (
              <li key={`${warning.rule}:${warning.reason}`}>
                Skipped {warning.rule}: {warning.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      <section className="rules-page__block">
        <h3>Bind rules</h3>
        {data.rules.length === 0 ? (
          <p className="muted">None yet. Copy src/data/bind-rules.example.json to bind-rules.json.</p>
        ) : (
          <ul>
            {data.rules.map((rule) => (
              <li key={rule.id}>
                <strong>{rule.label}</strong>
                {rule.kind === "require" ? (
                  <span className="muted"> — {rule.requireName ?? rule.require}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rules-page__block">
        <h3>Pending proposals</h3>
        {pending.length === 0 ? (
          <p className="muted">None. Strong usage can suggest a rule; you approve it on the command line.</p>
        ) : (
          <ul>
            {pending.map((row) => (
              <li key={row.id}>
                <code>{row.id}</code>
                <div>{row.summary}</div>
                <p className="muted">{row.evidence}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rules-page__block">
        <h3>Why this master</h3>
        <label>
          Master
          <select value={masterId} onChange={(event) => setMasterId(event.target.value)}>
            {masters.length === 0 ? <option value="">No graph loaded</option> : null}
            {masters.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name}
              </option>
            ))}
          </select>
        </label>
        <p className="rules-page__why">{why}</p>
      </section>
    </div>
  );
}
