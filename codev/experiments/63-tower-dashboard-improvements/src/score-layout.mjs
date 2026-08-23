import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function currentCardRows(ws) {
  // Matches renderInstance in packages/codev/templates/tower.html:
  // header, path, Overview, each terminal, New Shell, last-active meta.
  const nested = ws.running ? 1 + ws.terminals.length + 1 : 0;
  return 2 + nested + 1;
}

function flattenedRows() {
  return 1;
}

export function scoreLayout() {
  const fixture = JSON.parse(
    readFileSync(join(root, 'fixtures', 'workspaces.json'), 'utf8'),
  );
  const rows = fixture.workspaces.map((ws) => ({
    name: ws.workspaceName,
    terminals: ws.terminals.length,
    currentRows: currentCardRows(ws),
    flattenedRows: flattenedRows(ws),
  }));
  const currentTotal = rows.reduce((sum, row) => sum + row.currentRows, 0);
  const flatTotal = rows.reduce((sum, row) => sum + row.flattenedRows, 0);
  return {
    generatedAt: new Date().toISOString(),
    workspaceCount: rows.length,
    rows,
    currentTotalRows: currentTotal,
    flattenedTotalRows: flatTotal,
    oneRowPerWorkspace: flatTotal === rows.length,
    currentIsOneRow: currentTotal === rows.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = scoreLayout();
  const out = join(root, 'artifacts', 'layout-score.json');
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(out);
}
