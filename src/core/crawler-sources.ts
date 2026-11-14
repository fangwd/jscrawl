// A site and the shared crawler modules it imports. Keep validation, source
// fingerprints and submissions in agreement about the code being reviewed.
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';

import ts from 'typescript';

export function crawlerSources(entry: string): string[] {
  const root = resolve(dirname(entry), 'lib');
  const found = new Set<string>();
  const visit = (file: string) => {
    if (found.has(file)) return;
    found.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    const walk = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.push(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        node.arguments.length &&
        ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const base = resolve(dirname(file), specifier);
      if (!base.startsWith(root + sep)) continue;
      const candidates = /\.[cm]?[jt]s$/.test(base)
        ? [base.replace(/\.js$/, '.ts'), base]
        : [`${base}.ts`, `${base}.js`, resolve(base, 'index.ts'), resolve(base, 'index.js')];
      const dependency = candidates.find(existsSync);
      if (!dependency)
        throw new Error(`Missing shared crawler module ${specifier} imported by ${file}`);
      visit(dependency);
    }
  };
  visit(resolve(entry));
  return [...found].sort();
}
