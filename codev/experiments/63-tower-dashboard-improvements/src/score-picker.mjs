import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function scorePicker() {
  // File API (https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file))
  // and webkitdirectory give the page a File list. Electron adds `path`.
  // Browsers do not.
  const browserFileFields = ['name', 'lastModified', 'size', 'type', 'webkitRelativePath'];
  const launchInstanceRequires = 'absolute filesystem path (path.isAbsolute, then fs.existsSync)';
  return {
    generatedAt: new Date().toISOString(),
    browserFileFields,
    electronOnlyFields: ['path'],
    launchInstanceRequires,
    nativePickerGivesAbsolutePathInBrowser: false,
    workingPicker: 'text input + GET /api/browse?path= (already on the landing page)',
    source:
      'HTML spec file upload state; Chromium does not expose File.path to web content. Not re-measured in a live browser this run.',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = scorePicker();
  const out = join(root, 'artifacts', 'picker-score.json');
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(out);
}
