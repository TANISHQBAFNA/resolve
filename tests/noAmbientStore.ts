// Tests build their own stores. An ambient store folder (and any code map in it) must not leak in.
// The per-project copy (.resolve/local) is off unless a test turns it on, so runs never write into the repo.
delete process.env["GRAPHIFY_HOME"];
delete process.env["RESOLVE_HOME"];

const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
if (major < 22 || (major === 22 && minor < 12)) {
  throw new Error(
    `Resolve tests need Node 22.12 or newer. This process is Node ${process.versions.node}. Upgrade Node, then run the tests again.`,
  );
}
process.env["RESOLVE_PROJECT_COPY"] = "0";
