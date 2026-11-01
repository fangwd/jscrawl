// Validates the shop components against Nova's schemas and writes them, in
// the shape of a Builder snapshot export, to shop-components.json. With
// --render, also renders each section through Nova's publish pipeline against
// the local main library and theme into /tmp/shop-render/<id>.html.
// Run from nova/backend: npx tsx --env-file=.env ../../jscrawl/nova/build.ts [--render]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ComponentDefinition } from '@base/builder/schema/components';
import { validateComponentDefinition } from '@base/builder/schema/validation/definition-schema';

import {
  CLASSES as LIBRARY_CLASSES,
  COMPONENTS as LIBRARY_COMPONENTS,
  REGISTRY,
  registryBody,
} from '../../nova/scripts/shop-components/library';
import { CLASSES, COMPONENTS, NEW_REGISTRY, REFERENCES } from './shop-components';

const OUT = join(__dirname, 'shop-components.json');

/** Registry markers become stand-in ids, as library's render.ts does. */
const REGISTRY_KEYS = [...REGISTRY, ...NEW_REGISTRY].map((e) => e.memoryKey);
function withStandIns(component: Record<string, unknown>): ComponentDefinition {
  const props = (component.props as Record<string, unknown>[]).map(
    ({ reg, ...prop }) =>
      typeof reg === 'string'
        ? { id: 900_000 + REGISTRY_KEYS.indexOf(reg), ...prop }
        : prop,
  );
  return { ...component, props } as unknown as ComponentDefinition;
}

function validate(): boolean {
  let ok = true;
  for (const component of COMPONENTS.map(withStandIns)) {
    const issues = validateComponentDefinition(component);
    if (issues) {
      ok = false;
      console.error(`✗ ${component.id}`, JSON.stringify(issues.slice(0, 5), null, 2));
    }
  }
  return ok;
}

function write() {
  const snapshot = {
    version: 4,
    components: COMPONENTS,
    componentSources: Object.fromEntries(COMPONENTS.map((c) => [c.id, 'user'])),
    componentMemory: NEW_REGISTRY.map((entry) => ({
      ...registryBody(entry),
      shop: entry.shop,
    })),
    themes: [{ id: 'default-theme', classes: CLASSES }],
    references: REFERENCES,
  };
  writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote ${OUT}: ${COMPONENTS.length} components`);
}

async function render() {
  const { buildPreviewResolver, renderComponentDocument } = await import('@base/render');
  const { dbRowToComponentDefinition, dbRowToProjectTheme } = await import(
    '../../nova/backend/src/routes/component-utils'
  );
  const { default: prisma } = await import('../../nova/backend/src/prisma');
  const rows = await prisma.componentDefinition.findMany({ where: { branchId: 'main' } });
  const themeRow = await prisma.projectTheme.findFirstOrThrow({
    where: { branchId: 'main', id: 'default-theme' },
  });
  await prisma.$disconnect();
  const ours = [...LIBRARY_COMPONENTS, ...COMPONENTS].map(withStandIns);
  const library = rows.flatMap((row) => {
    try {
      return [dbRowToComponentDefinition(row)];
    } catch {
      return [];
    }
  });
  const all = [...library.filter((c) => !ours.some((o) => o.id === c.id)), ...ours];
  const theme = dbRowToProjectTheme(themeRow);
  theme.classes = {
    ...theme.classes,
    ...(LIBRARY_CLASSES as typeof theme.classes),
    ...(CLASSES as typeof theme.classes),
  };
  mkdirSync('/tmp/shop-render', { recursive: true });
  for (const component of COMPONENTS.map(withStandIns)) {
    if (component.componentLevel !== 'section') continue;
    const { componentId, resolve } = buildPreviewResolver(component, all);
    const rendered = renderComponentDocument({ componentId, resolve, allComponents: all, theme });
    if (!rendered) {
      console.error(`✗ ${component.id} did not render`);
      continue;
    }
    writeFileSync(`/tmp/shop-render/${component.id}.html`, rendered.document);
    console.log(`✓ ${component.id}`);
  }
}

async function main() {
  if (!validate()) process.exit(1);
  write();
  if (process.argv.includes('--render')) await render();
}

void main();
