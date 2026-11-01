import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { relative, resolve } from 'path';
import ts from 'typescript';
import { Config } from './models';
import { siteModulePath } from './sites';

export interface CrawlerDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  code: number;
  message: string;
}

/** Check the crawler and its imports without executing it or emitting files. */
export function typecheckCrawler(config: Config, name: string, cwd: string) {
  const modulePath = siteModulePath(name, config);
  const file = ts.sys.fileExists(`${modulePath}.ts`) ? `${modulePath}.ts` : `${modulePath}.js`;
  const sourceHash = createHash('sha256').update(readFileSync(file)).digest('hex');
  const project = resolve(cwd, 'tsconfig.json');
  const loaded = ts.readConfigFile(project, ts.sys.readFile);
  const parsed = loaded.error ? undefined : ts.parseJsonConfigFileContent(loaded.config, ts.sys, cwd);
  const errors = loaded.error ? [loaded.error] : [...parsed!.errors];
  if (!errors.length) {
    const program = ts.createProgram([file], {
      ...parsed!.options,
      noEmit: true,
      incremental: false,
      composite: false,
      ...(file.endsWith('.js') ? { allowJs: true, checkJs: true } : {}),
    });
    errors.push(...ts.getPreEmitDiagnostics(program));
  }
  const diagnostics: CrawlerDiagnostic[] = errors.map((error) => {
    const position = error.file && error.start !== undefined
      ? error.file.getLineAndCharacterOfPosition(error.start) : undefined;
    return {
      ...(error.file ? { file: relative(cwd, error.file.fileName) } : {}),
      ...(position ? { line: position.line + 1, column: position.character + 1 } : {}),
      code: error.code,
      message: ts.flattenDiagnosticMessageText(error.messageText, '\n'),
    };
  });
  return { ok: diagnostics.length === 0, file: relative(cwd, file), sourceHash, diagnostics };
}
