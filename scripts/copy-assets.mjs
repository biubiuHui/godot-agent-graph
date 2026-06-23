import { chmodSync, copyFileSync, cpSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function copyFile(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

copyFile("src/db/schema.sql", "dist/db/schema.sql");
cpSync(".agents/skills/godot-graph-navigation", "dist/skills/godot-graph-navigation", {
  recursive: true,
});
chmodSync("dist/bin/gdgraph.js", 0o755);
