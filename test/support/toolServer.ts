import { spawn } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

/** Starts the jscrawl tool server (src/mcp/server.ts) on a free port; resolves once it listens. */
export async function startToolServer(env: NodeJS.ProcessEnv): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/mcp/server.ts'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`the tool server did not start: ${output}`)), 60_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/jscrawl tool server on (http:\/\/\S+\/mcp)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`the tool server exited (${code}): ${output}`));
    });
  });
  return { url, stop: () => child.kill('SIGTERM') };
}
