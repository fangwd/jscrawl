// The agent's skills (separate-core-app-impl.md §5.10, §7): the core's, in this
// package's skills/, merged with the domain's (DomainConfig.skills.dir). A file
// both have is an error, but for a skill's SKILL.md: the domain's is appended to
// the core's, so a domain extends a core skill without restating it. Core text
// names the domain's inspect tool as {{inspectTool}}, filled in here.

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
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
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
      else if (path.endsWith('SKILL.md')) files.set(path, `${core.trimEnd()}\n\n${content.replace(/^---\n[\s\S]*?\n---\n/, '').trim()}\n`);
      else throw new Error(`skills: ${path} is in both the core's and the domain's skills`);
    }
  }
  const fill = (text: string) => text.replaceAll('{{inspectTool}}', inspectTool);
  return {
    inspectTool,
    instructions: fill(skills?.instructions ?? ''),
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content: fill(content) })),
  };
}
