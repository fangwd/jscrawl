// Merges the package's skills/ with DomainConfig.skills.dir. Duplicate paths
// are errors except for SKILL.md, where the domain's text is appended without
// its front matter. {{inspectTool}} is replaced with the domain's tool name.

import { readdir, readFile } from 'fs/promises';
import { join, relative, resolve } from 'path';

import { domain } from './domain';

/** The core's skills: skills/ at the package root, beside src/ and dist/. */
export const CORE_SKILLS_DIR = resolve(__dirname, '..', '..', 'skills');

export interface AgentSkills {
  inspectTool: string;
  /** The domain's part of the agent's instructions, appended to the agent's own. */
  instructions: string;
  /** Every skill file, by path under the skills directory. */
  files: { path: string; content: string }[];
}

async function filesUnder(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    out.set(relative(dir, file), await readFile(file, 'utf8'));
  }
  return out;
}

export async function agentSkills(coreDir = CORE_SKILLS_DIR): Promise<AgentSkills> {
  const { inspectTool, skills } = domain();
  const files = await filesUnder(coreDir);
  if (skills) {
    for (const [path, content] of await filesUnder(skills.dir)) {
      const core = files.get(path);
      if (core === undefined) files.set(path, content);
      else if (path.endsWith('SKILL.md'))
        files.set(
          path,
          `${core.trimEnd()}\n\n${content.replace(/^---\n[\s\S]*?\n---\n/, '').trim()}\n`,
        );
      else throw new Error(`skills: ${path} is in both the core's and the domain's skills`);
    }
  }
  const fill = (text: string) => text.replaceAll('{{inspectTool}}', inspectTool);
  return {
    inspectTool,
    instructions: fill(skills?.instructions ?? ''),
    files: [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => ({ path, content: fill(content) })),
  };
}
