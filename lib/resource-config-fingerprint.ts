import { statSync } from "fs";
import { join } from "path";

/**
 * Returns a cheap fingerprint for files and directories whose changes can alter
 * Pi's loaded extensions, prompts, skills, or themes. This lets a long-lived web
 * session notice package installs performed by the plugin UI or another Pi
 * process without polling or rebuilding its AgentSession on every request.
 */
export function getResourceConfigFingerprint(cwd: string, agentDir: string): string {
  const projectDir = join(cwd, ".pi");
  const paths = [
    join(agentDir, "settings.json"),
    join(agentDir, "npm", "package-lock.json"),
    join(agentDir, "git"),
    join(agentDir, "extensions"),
    join(agentDir, "prompts"),
    join(agentDir, "skills"),
    join(projectDir, "settings.json"),
    join(projectDir, "npm", "package-lock.json"),
    join(projectDir, "git"),
    join(projectDir, "extensions"),
    join(projectDir, "prompts"),
    join(projectDir, "skills"),
  ];

  return paths.map((path) => {
    try {
      const stat = statSync(path);
      return `${path}\0${stat.mtimeMs}\0${stat.size}`;
    } catch {
      return `${path}\0missing`;
    }
  }).join("\n");
}
