import type { CSSProperties } from "react";
import { useGraphStore } from "@/state/graphStore";
import { useAtlas } from "@/state/selectors";
import { HealthChip } from "@/ui/overview/Stat";
import { communityCohesion } from "@/ui/overview/health";

/**
 * The communities list, in the spirit of a graph tool's legend: each partition
 * named after its highest-degree member, sized, coloured, and switchable.
 */
export function CommunityPanel() {
  const atlas = useAtlas();
  const hidden = useGraphStore((state) => state.atlas.hiddenCommunities);
  const collapseInstances = useGraphStore((state) => state.atlas.collapseInstances);
  const resolution = useGraphStore((state) => state.atlas.resolution);
  const excludeHubs = useGraphStore((state) => state.atlas.excludeHubs);
  const minDegree = useGraphStore((state) => state.atlas.minDegree);
  const setAtlas = useGraphStore((state) => state.setAtlas);
  const toggleCommunity = useGraphStore((state) => state.toggleCommunity);
  const setAllCommunities = useGraphStore((state) => state.setAllCommunities);
  const focusNode = useGraphStore((state) => state.focusNode);

  if (!atlas) return null;

  const all = atlas.communities.communities;
  const allIds = all.map((community) => community.id);
  const hiddenSet = new Set(hidden);
  const allVisible = hidden.length === 0;

  return (
    <section className="communities" aria-label="Communities">
      <header className="panel__header">
        <h2>Communities</h2>
        <span className="panel__count">{all.length}</span>
      </header>

      <div className="communities__toolbar">
        <label className="communities__row communities__row--all">
          <input
            type="checkbox"
            checked={allVisible}
            onChange={(event) => setAllCommunities(allIds, event.target.checked)}
          />
          <span className="communities__name">Show all clusters</span>
        </label>
      </div>

      <ul className="communities__list">
        {all.map((community) => {
          const isHidden = hiddenSet.has(community.id);
          const cohesion = communityCohesion(community.size, community.internalEdges);
          const chip = isHidden
            ? { label: "Hidden", tone: "watch" as const }
            : cohesion;
          return (
            <li key={community.id}>
              <article
                className={`community-card${isHidden ? " is-hidden" : ""}`}
                style={{ "--community-color": community.color } as CSSProperties}
              >
                <label className="community-card__toggle">
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => toggleCommunity(community.id)}
                  />
                  <span className="visually-hidden">Show {community.name}</span>
                </label>
                <div className="community-card__body">
                  <div className="community-card__top">
                    <button
                      type="button"
                      className="community-card__title"
                      title={`Hub: ${community.name} · ${community.internalEdges} internal edges`}
                      onClick={() => focusNode(community.hubId)}
                    >
                      {community.name}
                    </button>
                    <HealthChip tone={chip.tone} label={chip.label} />
                  </div>
                  <p className="community-card__meta">
                    {community.size} nodes · {community.internalEdges} internal edges
                  </p>
                </div>
                <span className="community-card__count">{community.size}</span>
              </article>
            </li>
          );
        })}
      </ul>

      <details className="communities__settings">
        <summary>Cluster settings</summary>
        <div className="communities__controls">
          <label className="communities__toggle">
            <input
              type="checkbox"
              checked={collapseInstances}
              onChange={(event) => setAtlas({ collapseInstances: event.target.checked })}
            />
            Collapse instances into components
          </label>

          <label className="communities__toggle">
            <input
              type="checkbox"
              checked={excludeHubs}
              onChange={(event) => setAtlas({ excludeHubs: event.target.checked })}
            />
            Exclude hubs from clustering
          </label>

          <label className="communities__slider">
            <span>
              Resolution <b>{resolution.toFixed(1)}</b>
            </span>
            <input
              type="range"
              min={0.4}
              max={2.4}
              step={0.2}
              value={resolution}
              onChange={(event) => setAtlas({ resolution: Number(event.target.value) })}
            />
          </label>

          <label className="communities__slider">
            <span>
              Min degree <b>{minDegree}</b>
            </span>
            <input
              type="range"
              min={0}
              max={4}
              step={1}
              value={minDegree}
              onChange={(event) => setAtlas({ minDegree: Number(event.target.value) })}
            />
          </label>
        </div>
      </details>
    </section>
  );
}
