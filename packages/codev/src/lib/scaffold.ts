/**
 * Scaffold utilities shared across codev init / adopt / update.
 *
 * Directory creation, skeleton copying, and root-file templating. Gitignore
 * management lives in `./gitignore.ts` (extracted in issue #882).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

interface CreateUserDirsOptions {
  skipExisting?: boolean;
}

interface CreateUserDirsResult {
  created: string[];
  skipped: string[];
}

/**
 * Create user data directories (specs, plans, reviews) with .gitkeep files
 */
export function createUserDirs(
  targetDir: string,
  options: CreateUserDirsOptions = {}
): CreateUserDirsResult {
  const { skipExisting = false } = options;
  const userDirs = ['specs', 'plans', 'reviews'];
  const created: string[] = [];
  const skipped: string[] = [];

  for (const dir of userDirs) {
    const dirPath = path.join(targetDir, 'codev', dir);
    if (skipExisting && fs.existsSync(dirPath)) {
      skipped.push(dir);
      continue;
    }
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, '.gitkeep'), '');
    created.push(dir);
  }

  return { created, skipped };
}

interface CopyConsultTypesOptions {
  skipExisting?: boolean;
}

interface CopyConsultTypesResult {
  copied: string[];
  skipped: string[];
  directoryCreated: boolean;
}

/**
 * Copy consult-types directory from skeleton.
 * Contains review type prompts that users can customize.
 */
export function copyConsultTypes(
  targetDir: string,
  skeletonDir: string,
  options: CopyConsultTypesOptions = {}
): CopyConsultTypesResult {
  const { skipExisting = false } = options;
  const consultTypesDir = path.join(targetDir, 'codev', 'consult-types');
  const srcDir = path.join(skeletonDir, 'consult-types');
  const copied: string[] = [];
  const skipped: string[] = [];
  let directoryCreated = false;

  // Ensure consult-types directory exists
  if (!fs.existsSync(consultTypesDir)) {
    fs.mkdirSync(consultTypesDir, { recursive: true });
    directoryCreated = true;
  }

  // If source directory doesn't exist, return early
  if (!fs.existsSync(srcDir)) {
    return { copied, skipped, directoryCreated };
  }

  // Copy all .md files from skeleton consult-types
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const destPath = path.join(consultTypesDir, file);
    const srcPath = path.join(srcDir, file);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(file);
      continue;
    }

    fs.copyFileSync(srcPath, destPath);
    copied.push(file);
  }

  return { copied, skipped, directoryCreated };
}

interface CopyResourceTemplatesOptions {
  skipExisting?: boolean;
}

interface CopyResourceTemplatesResult {
  copied: string[];
  skipped: string[];
}

/**
 * Copy resource templates (lessons-learned.md, arch.md)
 */
export function copyResourceTemplates(
  targetDir: string,
  skeletonDir: string,
  options: CopyResourceTemplatesOptions = {}
): CopyResourceTemplatesResult {
  const { skipExisting = false } = options;
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  const copied: string[] = [];
  const skipped: string[] = [];

  // Ensure resources directory exists
  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  const templates = ['lessons-learned.md', 'arch.md', 'cheatsheet.md', 'lifecycle.md'];
  for (const template of templates) {
    const destPath = path.join(resourcesDir, template);
    const srcPath = path.join(skeletonDir, 'templates', template);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(template);
      continue;
    }

    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      copied.push(template);
    }
  }

  return { copied, skipped };
}

/** The capped hot-tier files materialized into a project's codev/resources/ (Spec 987). */
export const HOT_TIER_FILES = ['arch-critical.md', 'lessons-critical.md'] as const;

/**
 * Copy the hot-tier files (arch-critical.md, lessons-critical.md) from the skeleton
 * into the project's codev/resources/.
 *
 * Spec 987: these are framework-provided starters each project then curates. Porch
 * injection and the CLAUDE/AGENTS managed block resolve them via the four-tier chain
 * (so injection works even before this runs), but materializing local copies makes the
 * hot tier visible and per-project editable. `skipExisting` so a curated copy is never
 * overwritten. This is a focused, wired-in step — distinct from the dead
 * `copyResourceTemplates` (which init/adopt/update do not call).
 */
export function copyHotTierDefaults(
  targetDir: string,
  skeletonDir: string,
  options: CopyResourceTemplatesOptions = {}
): CopyResourceTemplatesResult {
  const { skipExisting = false } = options;
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  for (const file of HOT_TIER_FILES) {
    const destPath = path.join(resourcesDir, file);
    const srcPath = path.join(skeletonDir, 'templates', file);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(file);
      continue;
    }
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      copied.push(file);
    }
  }

  return { copied, skipped };
}

/**
 * Cold-tier governance files: the skeleton starter to copy from → the project-local
 * filename it materializes as (issue #1012).
 *
 * The starter sources are minimal placeholders (`*.starter.md`) kept separate from the rich
 * `templates/{arch,lessons-learned}.md` reference templates — those carry a "this file is not
 * copied into projects" note and are the manual-`cp` opt-in, so they must not be the copied
 * starter. Each project instead gets a trivial placeholder it grows over time, enough for the
 * review-phase read to succeed against a real, locally-owned file.
 */
export const COLD_TIER_FILES = [
  { src: 'arch.starter.md', dest: 'arch.md' },
  { src: 'lessons-learned.starter.md', dest: 'lessons-learned.md' },
] as const;

/**
 * Copy the cold-tier governance files (arch.md, lessons-learned.md) from the skeleton's
 * `*.starter.md` placeholders into the project's codev/resources/.
 *
 * Companion to `copyHotTierDefaults`: Spec 987 materializes the hot tier on
 * init/adopt/update but left the cold tier — which the review prompts read and the hot-tier
 * maps point into — uncreated. `skipExisting` so a curated file is never overwritten (the
 * cold files are already registered as protected user data in templates.ts). Results are
 * keyed by the destination filename.
 */
export function copyColdTierDefaults(
  targetDir: string,
  skeletonDir: string,
  options: CopyResourceTemplatesOptions = {}
): CopyResourceTemplatesResult {
  const { skipExisting = false } = options;
  const resourcesDir = path.join(targetDir, 'codev', 'resources');
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!fs.existsSync(resourcesDir)) {
    fs.mkdirSync(resourcesDir, { recursive: true });
  }

  for (const { src, dest } of COLD_TIER_FILES) {
    const destPath = path.join(resourcesDir, dest);
    const srcPath = path.join(skeletonDir, 'templates', src);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(dest);
      continue;
    }
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      copied.push(dest);
    }
  }

  return { copied, skipped };
}

interface CopyRootFilesOptions {
  handleConflicts?: boolean;
  /**
   * Issue #31: when true, report what WOULD happen and write nothing.
   *
   * `codev update --dry-run` printed "no files will be changed" and then wrote
   * `.codev-new` siblings, because only the skills call was guarded and this one
   * was not. A dry run that writes is worse than no dry run: it is the one mode
   * an operator trusts specifically because it promised not to touch anything.
   */
  dryRun?: boolean;
}

interface CopyRootFilesResult {
  copied: string[];
  conflicts: string[];
  /**
   * Issue #30: files that exist and are byte-identical to the template.
   *
   * Previously these were reported as conflicts with the reason "Content differs
   * from template" — a claim nothing had checked, since existence was the only
   * test. Every update handed the operator a merge task that was usually a no-op.
   */
  unchanged: string[];
}

/**
 * Copy root files (CLAUDE.md, AGENTS.md) with project name substitution
 */
export function copyRootFiles(
  targetDir: string,
  skeletonDir: string,
  projectName: string,
  options: CopyRootFilesOptions = {}
): CopyRootFilesResult {
  const { handleConflicts = false, dryRun = false } = options;
  const copied: string[] = [];
  const conflicts: string[] = [];
  const unchanged: string[] = [];

  const rootFiles = ['CLAUDE.md', 'AGENTS.md'];
  for (const file of rootFiles) {
    const srcPath = path.join(skeletonDir, 'templates', file);
    const destPath = path.join(targetDir, file);

    if (!fs.existsSync(srcPath)) {
      continue;
    }

    const content = fs.readFileSync(srcPath, 'utf-8')
      .replace(/\{\{PROJECT_NAME\}\}/g, projectName);

    if (fs.existsSync(destPath)) {
      // Issue #30: actually compare before claiming the content differs. An
      // unreadable destination counts as "differs" — that is the direction that
      // surfaces the file for a human to look at, rather than silently calling
      // it clean.
      let current: string | null = null;
      try {
        current = fs.readFileSync(destPath, 'utf-8');
      } catch {
        current = null;
      }

      if (current === content) {
        unchanged.push(file);
        continue;
      }

      if (handleConflicts) {
        conflicts.push(file);
        // Issue #31: a dry run reports the conflict but writes no sibling.
        if (!dryRun) {
          fs.writeFileSync(destPath + '.codev-new', content);
        }
      }
      // Skip if exists and not handling conflicts
    } else {
      copied.push(file);
      if (!dryRun) {
        fs.writeFileSync(destPath, content);
      }
    }
  }

  return { copied, conflicts, unchanged };
}

interface CreateProjectsDirOptions {
  skipExisting?: boolean;
}

interface CreateProjectsDirResult {
  created: boolean;
  skipped: boolean;
}

/**
 * Create codev/projects/ directory for porch state files
 */
export function createProjectsDir(
  targetDir: string,
  options: CreateProjectsDirOptions = {}
): CreateProjectsDirResult {
  const { skipExisting = false } = options;
  const projectsDir = path.join(targetDir, 'codev', 'projects');

  if (skipExisting && fs.existsSync(projectsDir)) {
    return { created: false, skipped: true };
  }

  fs.mkdirSync(projectsDir, { recursive: true });
  fs.writeFileSync(path.join(projectsDir, '.gitkeep'), '');
  return { created: true, skipped: false };
}

/**
 * Recursively copy a directory
 */
function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

interface CopySkillsOptions {
  skipExisting?: boolean;
  /**
   * Issue #29: refresh a vendored skill whose content still matches an older
   * shipped version, and leave a locally-edited one alone.
   *
   * `skipExisting` alone tests the skill DIRECTORY, so once a skill exists its
   * contents are frozen at install time forever. `--force` never helped: that
   * branch only wrapped `copyRootFiles`. The comment said "without replacing
   * customizations", but with no comparison the code could not tell a
   * customization from a stale copy, so it preserved both — which in practice
   * means it preserved rot. Real cost: vendored skills stating the OPPOSITE of
   * current behavior (the `afx` skill claiming `--branch` does not exist), and
   * agents burning turns on flags that were removed releases ago.
   */
  refreshUnmodified?: boolean;
}

interface CopySkillsResult {
  /** Project-relative provider-qualified paths, including a trailing slash. */
  copied: string[];
  /** Project-relative provider-qualified paths, including a trailing slash. */
  skipped: string[];
  /**
   * Skills refreshed because their content was unmodified but stale (#29).
   * Project-relative provider-qualified paths, including a trailing slash.
   */
  refreshed: string[];
  /**
   * Skills left alone because they carry local edits (#29). Reported rather
   * than silently skipped: a customization that is now blocking an update is
   * exactly what an operator needs told.
   */
  customized: string[];
  /** Project-relative provider skill roots that were created. */
  directoriesCreated: string[];
}

/** Filename of the per-provider skill manifest (#29). */
export const SKILL_MANIFEST_FILENAME = '.codev-skill-manifest.json';

/**
 * Content hash of a skill directory: every file's relative path and bytes.
 *
 * Returns null when the tree cannot be read. Callers treat null as "I could not
 * tell", never as "unchanged".
 */
function hashSkillDir(dir: string): string | null {
  const files: string[] = [];
  const visit = (d: string, prefix: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) visit(abs, rel);
      else if (entry.isFile()) files.push(`${rel} ${fs.readFileSync(abs, 'utf-8')}`);
    }
  };
  try {
    visit(dir, '');
  } catch {
    return null;
  }
  return createHash('sha256').update(files.join('')).digest('hex');
}

/**
 * Read the skill manifest for a provider's skills dir.
 *
 * Absent or unparseable manifest yields an empty map, which makes every skill
 * "unknown provenance" rather than "unmodified" — the direction that leaves
 * local work alone.
 */
function readSkillManifest(skillsDir: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(path.join(skillsDir, SKILL_MANIFEST_FILENAME), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch { /* absent or unreadable — treat as empty */ }
  return {};
}

function writeSkillManifest(skillsDir: string, manifest: Record<string, string>): void {
  fs.writeFileSync(
    path.join(skillsDir, SKILL_MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

export const SKILL_PROVIDERS = ['claude', 'codex'] as const;

/**
 * Copy provider-native skill trees from the skeleton to the project root.
 *
 * Each skill directory is the preservation boundary: skipExisting leaves an
 * existing skill completely untouched while still backfilling missing skills
 * for either provider.
 */
export function copySkills(
  targetDir: string,
  skeletonDir: string,
  options: CopySkillsOptions = {}
): CopySkillsResult {
  const { skipExisting = false, refreshUnmodified = false } = options;
  const copied: string[] = [];
  const skipped: string[] = [];
  const refreshed: string[] = [];
  const customized: string[] = [];
  const directoriesCreated: string[] = [];

  for (const provider of SKILL_PROVIDERS) {
    const relativeSkillsDir = `.${provider}/skills`;
    const skillsDir = path.join(targetDir, relativeSkillsDir);
    const srcDir = path.join(skeletonDir, relativeSkillsDir);

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
      directoriesCreated.push(`${relativeSkillsDir}/`);
    }

    // Older/corrupt skeletons may not provide every configured provider.
    if (!fs.existsSync(srcDir)) continue;

    // Issue #29: provenance for "is this vendored copy modified, or just old?"
    const manifest = refreshUnmodified ? readSkillManifest(skillsDir) : {};
    let manifestChanged = false;

    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const srcSkillDir = path.join(srcDir, entry.name);
      const destSkillDir = path.join(skillsDir, entry.name);
      const relativeSkillDir = `${relativeSkillsDir}/${entry.name}/`;

      if (fs.existsSync(destSkillDir)) {
        if (!refreshUnmodified) {
          if (skipExisting) {
            skipped.push(relativeSkillDir);
            continue;
          }
        } else {
          const srcHash = hashSkillDir(srcSkillDir);
          const destHash = hashSkillDir(destSkillDir);
          const installedHash = manifest[entry.name];

          // Already current. Record the hash if we never had it, so the NEXT
          // update can tell modified from stale without another guess.
          if (srcHash !== null && destHash === srcHash) {
            skipped.push(relativeSkillDir);
            if (installedHash !== srcHash) {
              manifest[entry.name] = srcHash;
              manifestChanged = true;
            }
            continue;
          }

          // Unknown provenance (installed before manifests, or unreadable) or a
          // local edit. Both leave the copy alone — but they are REPORTED, not
          // silently skipped, because a customization now blocking an update is
          // exactly what an operator needs told.
          if (destHash === null || installedHash === undefined || destHash !== installedHash) {
            customized.push(relativeSkillDir);
            continue;
          }

          // Vendored copy still matches what we installed, and the skeleton has
          // moved: it is stale, not customized. Refresh it.
          copyDirRecursive(srcSkillDir, destSkillDir);
          refreshed.push(relativeSkillDir);
          if (srcHash !== null) {
            manifest[entry.name] = srcHash;
            manifestChanged = true;
          }
          continue;
        }
      }

      copyDirRecursive(srcSkillDir, destSkillDir);
      copied.push(relativeSkillDir);
      if (refreshUnmodified) {
        const srcHash = hashSkillDir(srcSkillDir);
        if (srcHash !== null) {
          manifest[entry.name] = srcHash;
          manifestChanged = true;
        }
      }
    }

    if (refreshUnmodified && manifestChanged) {
      writeSkillManifest(skillsDir, manifest);
    }
  }

  return { copied, skipped, refreshed, customized, directoriesCreated };
}

interface CopyRolesOptions {
  skipExisting?: boolean;
}

interface CopyRolesResult {
  copied: string[];
  skipped: string[];
  directoryCreated: boolean;
}

/**
 * Copy roles directory from skeleton to codev/roles/.
 * Contains role prompts (architect, builder, consultant) for agent sessions.
 */
export function copyRoles(
  targetDir: string,
  skeletonDir: string,
  options: CopyRolesOptions = {}
): CopyRolesResult {
  const { skipExisting = false } = options;
  const rolesDir = path.join(targetDir, 'codev', 'roles');
  const srcDir = path.join(skeletonDir, 'roles');
  const copied: string[] = [];
  const skipped: string[] = [];
  let directoryCreated = false;

  // Ensure roles directory exists
  if (!fs.existsSync(rolesDir)) {
    fs.mkdirSync(rolesDir, { recursive: true });
    directoryCreated = true;
  }

  // If source directory doesn't exist, return early
  if (!fs.existsSync(srcDir)) {
    return { copied, skipped, directoryCreated };
  }

  // Copy all .md files from skeleton roles
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const destPath = path.join(rolesDir, file);
    const srcPath = path.join(srcDir, file);

    if (skipExisting && fs.existsSync(destPath)) {
      skipped.push(file);
      continue;
    }

    fs.copyFileSync(srcPath, destPath);
    copied.push(file);
  }

  return { copied, skipped, directoryCreated };
}

interface CopyProtocolsOptions {
  skipExisting?: boolean;
}

interface CopyProtocolsResult {
  copied: string[];
  skipped: string[];
  directoryCreated: boolean;
}

/**
 * Copy protocol definitions from skeleton to codev/protocols/
 * Required for porch orchestration
 */
export function copyProtocols(
  targetDir: string,
  skeletonDir: string,
  options: CopyProtocolsOptions = {}
): CopyProtocolsResult {
  const { skipExisting = false } = options;
  const protocolsDir = path.join(targetDir, 'codev', 'protocols');
  const srcDir = path.join(skeletonDir, 'protocols');
  const copied: string[] = [];
  const skipped: string[] = [];
  let directoryCreated = false;

  // Ensure protocols directory exists
  if (!fs.existsSync(protocolsDir)) {
    fs.mkdirSync(protocolsDir, { recursive: true });
    directoryCreated = true;
  }

  // If source directory doesn't exist, return early
  if (!fs.existsSync(srcDir)) {
    return { copied, skipped, directoryCreated };
  }

  // Copy each protocol directory
  const protocols = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of protocols) {
    if (!entry.isDirectory()) {
      // Copy top-level files (like protocol-schema.json)
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(protocolsDir, entry.name);

      if (skipExisting && fs.existsSync(destPath)) {
        skipped.push(entry.name);
        continue;
      }

      fs.copyFileSync(srcPath, destPath);
      copied.push(entry.name);
      continue;
    }

    const destProtocolDir = path.join(protocolsDir, entry.name);
    const srcProtocolDir = path.join(srcDir, entry.name);

    if (skipExisting && fs.existsSync(destProtocolDir)) {
      skipped.push(entry.name + '/');
      continue;
    }

    copyDirRecursive(srcProtocolDir, destProtocolDir);
    copied.push(entry.name + '/');
  }

  return { copied, skipped, directoryCreated };
}
