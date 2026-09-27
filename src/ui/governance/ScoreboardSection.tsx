import { useEffect, useState } from "react";

interface ToolRow {
  tool: string;
  top1: number;
  top3: number;
  emptyWhenWeak: number;
  wrongCousinRate: number;
  leakRate: number;
  sizeP50: number;
  sizeMax: number;
  budget: number;
  overBudget: boolean;
}

interface TrendPoint {
  at: string;
  top1: number;
  inventRate: number;
  pass: boolean;
}

interface ScoreboardPayload {
  workspace: string;
  latest: {
    at: string;
    fileName?: string;
    cases: number;
    pass: boolean;
    inventRate: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    tools: ToolRow[];
  } | null;
  trend: TrendPoint[];
  hint: string;
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function ScoreboardSection({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<ScoreboardPayload | undefined>(undefined);

  useEffect(() => {
    void fetch("/api/scoreboard")
      .then((response) => (response.ok ? response.json() : undefined))
      .then((payload: ScoreboardPayload | undefined) => {
        if (payload) setData(payload);
      })
      .catch(() => undefined);
  }, []);

  const latest = data?.latest;
  const trend = data?.trend ?? [];

  return (
    <section className={compact ? "scoreboard scoreboard--compact" : "scoreboard"} aria-label="Scoreboard">
      <h3>Scoreboard</h3>
      {!data ? (
        <p className="muted">Loading the latest scoreboard run.</p>
      ) : !latest ? (
        <p className="muted">{data.hint}</p>
      ) : (
        <>
          <p>
            {latest.pass ? "Pass" : "Fail"} · {latest.cases} cases
            {latest.fileName ? ` · ${latest.fileName}` : ""} · {when(latest.at)}
          </p>
          <p className="muted">
            Invent {pct(latest.inventRate)} · latency p50 {latest.latencyP50Ms.toFixed(1)} ms / p95{" "}
            {latest.latencyP95Ms.toFixed(1)} ms
          </p>
          {compact ? null : (
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Top-1</th>
                  <th>Top-3</th>
                  <th>Empty ok</th>
                  <th>Wrong cousin</th>
                  <th>Leak</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {latest.tools.map((tool) => (
                  <tr key={tool.tool}>
                    <td>{tool.tool}</td>
                    <td>{pct(tool.top1)}</td>
                    <td>{pct(tool.top3)}</td>
                    <td>{pct(tool.emptyWhenWeak)}</td>
                    <td>{pct(tool.wrongCousinRate)}</td>
                    <td>{pct(tool.leakRate)}</td>
                    <td>
                      {tool.sizeP50}/{tool.sizeMax}
                      {tool.overBudget ? ` over ${tool.budget}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {trend.length > 1 ? (
            <p className="muted">
              Top-1 trend: {trend.map((point) => pct(point.top1)).join(" → ")}
            </p>
          ) : null}
          {compact ? null : <p className="muted">{data.hint}</p>}
        </>
      )}
    </section>
  );
}
