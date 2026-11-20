import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePath, WorkPlanError } from './db.mjs';

const GIT_CACHE_TTL_MS = 15_000;
const gitCache = new Map();

const IGNORED_SUBDIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.next',
  '.cache',
  'out',
]);

/**
 * Convert arbitrary text into a lowercase ASCII kebab-case slug.
 */
export function slugify(text, fallback = 'item') {
  const cleaned = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return cleaned || fallback;
}

/**
 * Resolve canonical git repository metadata for a directory (with 15s cache).
 * All worktrees of the same repository normalize to the exact same `repoId`.
 */
export function resolveGitInfo(dirPath) {
  const normDir = normalizePath(dirPath);
  if (!normDir) {
    return { isGit: false, repoId: '', topLevel: '', branch: '' };
  }

  let checkDir = normDir;
  try {
    if (fs.existsSync(normDir) && !fs.statSync(normDir).isDirectory()) {
      checkDir = normalizePath(path.dirname(normDir));
    }
  } catch {
    checkDir = normalizePath(path.dirname(normDir));
  }

  const now = Date.now();
  const cached = gitCache.get(checkDir);
  if (cached && now - cached.ts < GIT_CACHE_TTL_MS) {
    return cached.value;
  }

  let result = { isGit: false, repoId: '', topLevel: '', branch: '' };
  try {
    if (fs.existsSync(checkDir)) {
      const commonDirRaw = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: checkDir, timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      const topLevelRaw = execFileSync(
        'git',
        ['rev-parse', '--show-toplevel'],
        { cwd: checkDir, timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      let branch = '';
      try {
        branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: checkDir,
          timeout: 2000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (branch === 'HEAD') branch = '';
      } catch {
        branch = '';
      }
      result = {
        isGit: Boolean(commonDirRaw),
        repoId: normalizePath(commonDirRaw),
        topLevel: normalizePath(topLevelRaw),
        branch,
      };
    }
  } catch {
    result = { isGit: false, repoId: '', topLevel: '', branch: '' };
  }

  gitCache.set(checkDir, { ts: now, value: result });
  return result;
}

export function clearGitCache() {
  gitCache.clear();
}

/**
 * Normalize a file path relative to its git repository top-level when inside a git repo,
 * otherwise return its normalized absolute POSIX path.
 */
export function toRepoRelativePath(absFilePath, gitInfo) {
  const normFile = normalizePath(absFilePath);
  if (!normFile) return '';
  if (gitInfo?.isGit && gitInfo.topLevel) {
    const top = gitInfo.topLevel;
    const prefix = top.endsWith('/') ? top : `${top}/`;
    if (normFile === top) return '.';
    if (normFile.startsWith(prefix)) {
      return normFile.slice(prefix.length);
    }
  }
  return normFile;
}

/**
 * Parse Markdown plan into title + hierarchical H2 / H3 tasks.
 */
export function parseMarkdownPlan(mdText, fallbackTitle = 'Untitled Plan') {
  const lines = String(mdText || '').replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const tasks = [];
  let currentH2 = null;
  let currentH3 = null;
  let currentHeading = null;
  let currentTarget = null;
  let paragraphLines = [];
  let inCodeFence = false;

  const flushParagraph = () => {
    if (currentTarget && !currentTarget.brief && paragraphLines.length > 0) {
      currentTarget.brief = paragraphLines.join(' ').replace(/\s+/g, ' ').trim();
    }
    paragraphLines = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const h1 = /^#\s+(.+)$/.exec(trimmed);
    if (h1 && !title) {
      title = h1[1].trim();
      continue;
    }

    const h2 = /^##\s+(.+)$/.exec(trimmed);
    if (h2) {
      flushParagraph();
      currentH2 = {
        title: h2[1].replace(/\s*#+\s*$/, '').trim(),
        brief: '',
        children: [],
      };
      currentH3 = null;
      currentHeading = currentH2;
      tasks.push(currentH2);
      currentTarget = currentH2;
      continue;
    }

    const h3 = /^###\s+(.+)$/.exec(trimmed);
    if (h3 && currentH2) {
      flushParagraph();
      currentH3 = {
        title: h3[1].replace(/\s*#+\s*$/, '').trim(),
        brief: '',
      };
      currentH2.children.push(currentH3);
      currentHeading = currentH3;
      currentTarget = currentH3;
      continue;
    }

    const cb = /^[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(trimmed);
    if (cb) {
      flushParagraph();
      currentTarget = null;
      const cbTask = {
        title: cb[2].trim(),
        status: cb[1].toLowerCase() === 'x' ? 'DONE' : 'TODO',
      };
      if (currentHeading) {
        if (!Array.isArray(currentHeading.children)) {
          currentHeading.children = [];
        }
        currentHeading.children.push(cbTask);
      } else {
        tasks.push(cbTask);
      }
      continue;
    }

    if (!currentTarget) continue;

    if (!trimmed) {
      if (paragraphLines.length > 0) {
        flushParagraph();
      }
      continue;
    }

    if (!currentTarget.brief) {
      if (/^#{1,6}\s/.test(trimmed) || /^[-*_]{3,}$/.test(trimmed)) continue;
      paragraphLines.push(trimmed.replace(/^[-*+]\s+/, ''));
    }
  }
  flushParagraph();

  return {
    title: title || fallbackTitle,
    tasks,
  };
}

/**
 * Inspect a local directory and optionally generate top-level tasks per subdirectory.
 */
export function seedFromFolder(folderPath) {
  const norm = normalizePath(folderPath);
  const baseTitle = path.basename(norm) || 'Workspace Project';
  const tasks = [];
  try {
    const entries = fs.readdirSync(norm, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_SUBDIRS.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of dirs) {
      tasks.push({
        title: dir.name,
        brief: `Tasks for ${dir.name}/ directory`,
        files: [`${dir.name}/**`],
      });
    }
  } catch {
    // non-fatal if directory unreadable
  }
  return { title: baseTitle, tasks };
}

/**
 * Inspect a GitHub issue URL using the `gh` CLI (if installed) and extract `- [ ]` checkboxes.
 */
export function seedFromGithubIssue(url) {
  const trimmed = String(url || '').trim();
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/.exec(trimmed);
  if (!match) {
    return { title: null, tasks: [], warning: 'Unrecognized GitHub issue URL format' };
  }
  try {
    const raw = execFileSync('gh', ['issue', 'view', trimmed, '--json', 'title,body'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw);
    const bodyLines = String(parsed.body || '').replace(/\r\n/g, '\n').split('\n');
    const tasks = [];
    for (const line of bodyLines) {
      const cb = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
      if (cb) {
        tasks.push({
          title: cb[2].trim(),
          status: cb[1].toLowerCase() === 'x' ? 'DONE' : 'TODO',
        });
      }
    }
    return {
      title: parsed.title ? String(parsed.title).trim() : null,
      tasks,
      warning: null,
    };
  } catch (err) {
    return {
      title: null,
      tasks: [],
      warning: `gh CLI unavailable or issue fetch failed (${err?.message || 'error'}); stored source_ref only.`,
    };
  }
}

/**
 * Orchestrate project seeding from plain title, local Markdown file, local folder, or GitHub issue URL.
 */
export function seedProjectSource({ title, workspace_dir, source_ref, seed = true }) {
  const ref = String(source_ref || '').trim();
  const normWorkspace = normalizePath(workspace_dir || '');
  const gitInfo = normWorkspace ? resolveGitInfo(normWorkspace) : { isGit: false, repoId: '', topLevel: '', branch: '' };

  let resolvedTitle = String(title || '').trim();
  let tasks = [];
  let warning = null;
  let effectiveWorkspace = normWorkspace;
  let effectiveGit = gitInfo;

  if (!seed || !ref) {
    if (!resolvedTitle && effectiveWorkspace) {
      resolvedTitle = path.basename(effectiveWorkspace) || 'Untitled Project';
    }
    return {
      title: resolvedTitle || 'Untitled Project',
      workspace_dir: effectiveWorkspace,
      repo_id: effectiveGit.repoId || '',
      source_ref: ref,
      tasks,
      warning,
    };
  }

  if (/^https?:\/\/github\.com\//i.test(ref)) {
    const ghRes = seedFromGithubIssue(ref);
    if (!resolvedTitle && ghRes.title) resolvedTitle = ghRes.title;
    tasks = ghRes.tasks;
    warning = ghRes.warning;
  } else {
    const candidatePath = path.isAbsolute(ref)
      ? ref
      : effectiveWorkspace
        ? path.join(effectiveWorkspace, ref)
        : ref;
    const normRefPath = normalizePath(candidatePath);
    try {
      const stat = fs.statSync(normRefPath);
      if (stat.isFile()) {
        const mdText = fs.readFileSync(normRefPath, 'utf8');
        const fallback = path.basename(normRefPath, path.extname(normRefPath));
        const parsed = parseMarkdownPlan(mdText, fallback);
        if (!resolvedTitle) resolvedTitle = parsed.title;
        tasks = parsed.tasks;
        if (!effectiveWorkspace) {
          effectiveWorkspace = normalizePath(path.dirname(normRefPath));
          effectiveGit = resolveGitInfo(effectiveWorkspace);
        }
      } else if (stat.isDirectory()) {
        const seeded = seedFromFolder(normRefPath);
        if (!resolvedTitle) resolvedTitle = seeded.title;
        tasks = seeded.tasks;
        if (!effectiveWorkspace) {
          effectiveWorkspace = normRefPath;
          effectiveGit = resolveGitInfo(effectiveWorkspace);
        }
      }
    } catch {
      warning = `Source path not found locally (${ref}); created project without seeded tasks.`;
    }
  }

  if (!resolvedTitle && effectiveWorkspace) {
    resolvedTitle = path.basename(effectiveWorkspace);
  }

  return {
    title: resolvedTitle || 'Untitled Project',
    workspace_dir: effectiveWorkspace,
    repo_id: effectiveGit.repoId || '',
    source_ref: ref,
    tasks,
    warning,
  };
}

/**
 * Browse local directories (and optionally files) for the UI Path Picker.
 */
export function browseDirectory({
  dirPath = '',
  include_files = false,
  include_hidden = false,
  extensions = [],
  query = '',
  limit = 500,
} = {}) {
  const homeDir = normalizePath(os.homedir());
  const rawInput = String(dirPath || '').trim();
  const initial = rawInput ? normalizePath(rawInput) : homeDir;
  let resolvedDir = initial || homeDir;
  let notice = null;

  let isExistingDir = false;
  try {
    if (fs.existsSync(resolvedDir)) {
      const st = fs.statSync(resolvedDir);
      if (st.isDirectory()) {
        isExistingDir = true;
      } else {
        resolvedDir = normalizePath(path.dirname(resolvedDir));
        isExistingDir = fs.existsSync(resolvedDir) && fs.statSync(resolvedDir).isDirectory();
      }
    }
  } catch {
    isExistingDir = false;
  }

  if (!isExistingDir) {
    let cur = resolvedDir;
    let found = '';
    while (cur) {
      try {
        if (fs.existsSync(cur) && fs.statSync(cur).isDirectory()) {
          found = normalizePath(cur);
          break;
        }
      } catch {
        // continue walking up
      }
      const parentCandidate = normalizePath(path.dirname(cur));
      if (!parentCandidate || parentCandidate === cur) break;
      cur = parentCandidate;
    }
    resolvedDir = found || homeDir;
    if (rawInput) {
      notice = `Path not found; showing ${resolvedDir}`;
    }
  }

  let dirents;
  try {
    dirents = fs.readdirSync(resolvedDir, { withFileTypes: true });
  } catch (err) {
    throw new WorkPlanError('UNREADABLE_DIR', `Cannot read directory "${resolvedDir}": ${err?.message || err}`);
  }

  const extSet = new Set(
    (Array.isArray(extensions) ? extensions : [])
      .map((e) => String(e || '').trim().toLowerCase())
      .filter(Boolean)
      .map((e) => (e.startsWith('.') ? e : `.${e}`))
  );
  const q = String(query || '').trim().toLowerCase();

  const allEntries = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    if (!include_hidden && name.startsWith('.')) continue;

    const entryAbs = path.join(resolvedDir, name);
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(entryAbs).isDirectory();
      } catch {
        continue;
      }
    } else if (!isDir && !dirent.isFile()) {
      continue;
    }

    if (!isDir && !include_files) continue;
    if (!isDir && extSet.size > 0 && !extSet.has(path.extname(name).toLowerCase())) continue;
    if (q && !name.toLowerCase().includes(q)) continue;

    let entryGit = false;
    if (isDir) {
      try {
        entryGit = fs.existsSync(path.join(entryAbs, '.git'));
      } catch {
        entryGit = false;
      }
    }

    allEntries.push({
      name,
      path: normalizePath(entryAbs),
      is_dir: isDir,
      is_git_repo: entryGit,
    });
  }

  allEntries.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const cap = Math.max(1, Math.min(Number(limit) || 500, 1000));
  const truncated = allEntries.length > cap;
  const entries = truncated ? allEntries.slice(0, cap) : allEntries;

  const currentNorm = normalizePath(resolvedDir);
  const parentNorm = normalizePath(path.dirname(currentNorm));
  const parent = parentNorm && parentNorm !== currentNorm ? parentNorm : null;

  let currentGit = false;
  try {
    currentGit = fs.existsSync(path.join(currentNorm, '.git'));
  } catch {
    currentGit = false;
  }

  return {
    current: currentNorm,
    parent,
    home: homeDir,
    is_git_repo: currentGit,
    notice,
    truncated,
    entries,
  };
}
