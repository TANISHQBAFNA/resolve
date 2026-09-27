import { useEffect, useState } from "react";

interface ToolRow {
  tool: string;
  scored: number;
  top1: number;
  top1Count: number;
  top3: number;
  top3Applicable: boolean;
  candidatesP50: number;
  candidatesMax: number;
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

interface WorkspaceChoice {
  name: string;
  at: string;
}

interface ScoreboardPayload {
  workspace: string;
  workspaces: WorkspaceChoice[];
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

function top1Cell(tool: ToolRow): string {
  if (tool.tool === "recipe") return tool.scored ? `${tool.top1Count}/${tool.scored}` : "n/a";
  if (!tool.scored && tool.tool === "verify") return "n/a";
  return pct(tool.top1);
}

function top3Cell(tool: ToolRow): string {
  if (!tool.top3Applicable) {
    const count = tool.candidatesMax || tool.candidatesP50;
    return count ? `n/a (${count} candidate${count === 1 ? "" : "s"})` : "n/a";
  }
  return pct(tool.top3);
}

export function ScoreboardSection({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<ScoreboardPayload | undefined>(undefined);
  const [workspace, setWorkspace] = useState<string | undefined>(undefined);

  useEffect(() => {
    const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    void fetch(`/api/scoreboard${query}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((payload: ScoreboardPayload | undefined) => {
        if (payload) setData(payload);
      })
      .catch(() => undefined);
  }, [workspace]);

  const latest = data?.latest;
  const trend = data?.trend ?? [];
  const workspaces = data?.workspaces ?? [];
  const recipe = latest?.tools.find((tool) => tool.tool === "recipe");

  return (
    <section className={compact ? "scoreboard scoreboard--compact" : "scoreboard"} aria-label="Scoreboard">
      <h3>Scoreboard</h3>
      {!data ? (
        <p className="muted">Loading the latest scoreboard run.</p>
      ) : !latest ? (
        <p className="muted">{data.hint}</p>
      ) : (
        <>
          {workspaces.length > 1 ? (
            <label className="scoreboard__pick">
              Workspace
              <select
                value={data.workspace}
                onChange={(event) => setWorkspace(event.target.value)}
              >
                {workspaces.map((choice) => (
                  <option key={choice.name} value={choice.name}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted">Workspace {data.workspace}</p>
          )}
          <p>
            {latest.pass ? "Pass" : "Fail"} · {latest.cases} cases
            {latest.fileName ? ` · ${latest.fileName}` : ""} · {when(latest.at)}
          </p>
          <p className="muted">
            Invent {pct(latest.inventRate)} · latency p50 {latest.latencyP50Ms.toFixed(1)} ms / p95{" "}
            {latest.latencyP95Ms.toFixed(1)} ms
          </p>
          {compact || !recipe ? null : (
            <p className="muted">
              Recipe: {recipe.top1Count}/{recipe.scored} on screen cases.
            </p>
          )}
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
                    <td>{top1Cell(tool)}</td>
                    <td>{top3Cell(tool)}</td>
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
