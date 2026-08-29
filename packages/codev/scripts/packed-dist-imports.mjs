import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const RELATIVE_IMPORT =
  /(?:from|import)\(\s*['"](\.[^'"]+)['"]|from ['"](\.[^'"]+)['"]/g;

export function assertPackedDistRelativeImports(tarballPath) {
  const packDirectory = mkdtempSync(join(tmpdir(), 'packed-dist-'));
  try {
    const packedFiles = new Set(
      execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
        .trim()
        .split('\n'),
    );
    const distJs = [...packedFiles].filter(
      (f) => f.startsWith('package/dist/') && f.endsWith('.js'),
    );
    if (distJs.length === 0) {
      throw new Error('packed dist/ contains no .js files');
    }
    execFileSync('tar', ['-xzf', tarballPath, '-C', packDirectory]);
    const packageRoot = join(packDirectory, 'package');
    const missing = [];
    for (const file of distJs) {
      const abs = join(packDirectory, file);
      const source = readFileSync(abs, 'utf8');
      for (const match of source.matchAll(RELATIVE_IMPORT)) {
        const spec = match[1] ?? match[2];
        if (!spec) continue;
        const resolved = resolve(dirname(abs), spec.endsWith('.js') ? spec : `${spec}.js`);
        const packedPath = `package/${relative(packageRoot, resolved)}`;
        if (
          !packedFiles.has(packedPath) &&
          !packedFiles.has(packedPath.replace(/\.js$/, '.json'))
        ) {
          missing.push(`${file} -> ${spec}`);
        }
      }
    }
    if (missing.length > 0) {
      throw new Error(`relative imports missing from tarball:\n${missing.join('\n')}`);
    }
  } finally {
    rmSync(packDirectory, { recursive: true, force: true });
  }
}
