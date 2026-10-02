// Tests build their own stores. An ambient store folder (and any code map in it) must not leak in.
delete process.env["GRAPHIFY_HOME"];
delete process.env["RESOLVE_HOME"];
