import fs from 'node:fs';
import path from 'node:path';
import { normalizePath, nowIso, WorkPlanError } from './db.mjs';
import { listMemories, MEMORY_CATEGORIES, MEMORY_CONFIDENCES, MEMORY_INJECT_MODES, saveMemory } from './memory.mjs';

export const KP_MODES = ['auto', 'okf', 'markdown', 'disabled'];

const MAX_OKF_FILES = 120;
const MAX_OKF_DEPTH = 4;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.gemini']);

function slugify(text, fallback = 'item') {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

export function normalizeKpMode(mode, fallback = 'auto') {
  const clean = String(mode ?? '')
    .trim()
    .toLowerCase();
  if (!clean) return fallback;
  if (!KP_MODES.includes(clean)) {
    throw new WorkPlanError(
      'VALIDATION_ERROR',
      `Invalid kp_mode "${mode}". Allowed values: ${KP_MODES.join(', ')}.`
    );
  }
  return clean;
}

function toRepoRelative(absPath, workspaceDir) {
  if (!absPath) return '';
  const normAbs = normalizePath(absPath);
  const normWs = workspaceDir ? normalizePath(workspaceDir) : '';
  if (normWs && (normAbs === normWs || normAbs.startsWith(`${normWs}/`))) {
    const rel = normAbs.slice(normWs.length).replace(/^\/+/, '');
    return rel || '.';
  }
  return normAbs;
}

/**
 * Resolve a project's kp_path against workspace_dir.
 */
export function resolveKpAbsolutePath(kpPath, workspaceDir = '') {
  const raw = String(kpPath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw) || raw.startsWith('~')) {
    return normalizePath(raw);
  }
  if (workspaceDir) {
    return normalizePath(path.join(workspaceDir, raw));
  }
  return normalizePath(raw);
}

/**
 * Lightweight zero-dependency YAML frontmatter parser for OKF & Markdown files.
 * @param {string} rawText
 * @returns {{ hasFrontmatter: boolean, frontmatter: Record<string, any>, body: string }}
 */
export function parseFrontmatter(rawText) {
  const text = String(rawText ?? '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n') && text !== '---') {
    return { hasFrontmatter: false, frontmatter: {}, body: text };
  }
  const endIdx = text.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { hasFrontmatter: false, frontmatter: {}, body: text };
  }
  const yamlBlock = text.slice(4, endIdx);
  const afterClose = text.slice(endIdx + 4);
  const body = afterClose.startsWith('\n') ? afterClose.slice(1) : afterClose;

  const frontmatter = {};
  const lines = yamlBlock.split('\n');
  let currentListKey = null;

  const unquote = (v) => {
    const t = String(v || '').trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentListKey && /^-\s+/.test(trimmed)) {
      const itemVal = unquote(trimmed.replace(/^-\s+/, ''));
      if (itemVal) frontmatter[currentListKey].push(itemVal);
      continue;
    }

    const kvMatch = rawLine.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      currentListKey = null;
      continue;
    }

    const key = kvMatch[1].trim();
    const rawVal = kvMatch[2].trim();

    if (!rawVal) {
      frontmatter[key] = [];
      currentListKey = key;
      continue;
    }

    currentListKey = null;
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      const inner = rawVal.slice(1, -1).trim();
      frontmatter[key] = inner
        ? inner
            .split(',')
            .map((part) => unquote(part))
            .filter(Boolean)
        : [];
    } else if (rawVal === 'true' || rawVal === 'false') {
      frontmatter[key] = rawVal === 'true';
    } else {
      frontmatter[key] = unquote(rawVal);
    }
  }

  return { hasFrontmatter: true, frontmatter, body };
}

function extractFirstHeadingAndSummary(markdownBody, fallbackTitle = 'Untitled') {
  const lines = String(markdownBody || '').split('\n');
  let title = '';
  const summaryLines = [];
  let inCodeFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('```')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (!title) {
      const h = line.match(/^#{1,3}\s+(.+)$/);
      if (h) {
        title = h[1].trim();
        continue;
      }
    }
    if (!line || line.startsWith('#')) {
      if (summaryLines.length > 0) break;
      continue;
    }
    summaryLines.push(line.replace(/^[-*+]\s+/, ''));
    if (summaryLines.join(' ').length >= 280) break;
  }

  const summary = summaryLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 320);
  return {
    title: title || fallbackTitle,
    summary,
  };
}

function extractCodeFileRefs(text) {
  const found = new Set();
  const re = /`([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})`/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const candidate = m[1].trim();
    if (candidate && !candidate.startsWith('http') && !candidate.includes('..')) {
      found.add(candidate);
    }
  }
  return [...found].slice(0, 8);
}

/**
 * Map an OKF concept type or heading string to a Work Plan Memory category.
 */
export function inferCategoryFromTypeOrTitle(typeOrHeading = '') {
  const s = String(typeOrHeading || '').toLowerCase();
  if (MEMORY_CATEGORIES.includes(s)) return s;
  if (/\b(arch|table|schema|model|service|api|database|endpoint|component|system|dag)\b/.test(s)) {
    return 'architecture';
  }
  if (/\b(cmd|command|runbook|playbook|script|cli|test|build|deploy|workflow)\b/.test(s)) {
    return 'command';
  }
  if (/\b(conv|convention|style|naming|pattern|format|lint|standard)\b/.test(s)) {
    return 'convention';
  }
  if (/\b(pitfall|gotcha|incident|bug|warning|caveat|trap|issue|retry)\b/.test(s)) {
    return 'pitfall';
  }
  if (/\b(constraint|sla|limit|budget|quota|security|policy|requirement|invariant)\b/.test(s)) {
    return 'constraint';
  }
  if (/\b(metric|kpi|context|domain|glossary|role|team|overview|product)\b/.test(s)) {
    return 'context';
  }
  return 'fact';
}

function parseIndexLinks(indexBody) {
  const linkDescriptions = new Map();
  const sections = [];
  let currentSection = 'Overview';

  for (const rawLine of String(indexBody || '').split('\n')) {
    const line = rawLine.trim();
    const h = line.match(/^#{1,3}\s+(.+)$/);
    if (h) {
      currentSection = h[1].trim();
      if (!sections.includes(currentSection)) sections.push(currentSection);
      continue;
    }
    const linkMatch = line.match(/^[-*+]\s+\[([^\]]+)\]\(([^)]+)\)(?:\s*[-—:]\s*(.+))?$/);
    if (linkMatch) {
      const label = linkMatch[1].trim();
      const target = linkMatch[2].trim().replace(/^\.\//, '');
      const desc = (linkMatch[3] || '').trim();
      linkDescriptions.set(target, { label, description: desc, section: currentSection });
    }
  }
  return { linkDescriptions, sections };
}

function walkMarkdownFiles(rootDir) {
  const results = [];
  function visit(currentDir, depth) {
    if (depth > MAX_OKF_DEPTH || results.length >= MAX_OKF_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= MAX_OKF_FILES) break;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        visit(fullPath, depth + 1);
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        results.push(normalizePath(fullPath));
      }
    }
  }
  visit(rootDir, 0);
  return results;
}

function inspectOkfBundle({ bundleDir, indexFilePath, kpPath, kpMode, workspaceDir }) {
  const hasIndex = fs.existsSync(indexFilePath) && fs.statSync(indexFilePath).isFile();
  let indexRaw = '';
  if (hasIndex) {
    try {
      indexRaw = fs.readFileSync(indexFilePath, 'utf8');
    } catch {
      indexRaw = '';
    }
  }

  const parsedIndex = parseFrontmatter(indexRaw);
  const fm = parsedIndex.frontmatter || {};
  const fallbackName = path.basename(bundleDir) || 'Knowledge Pack';
  const extractedIndex = extractFirstHeadingAndSummary(parsedIndex.body, fallbackName);
  const { linkDescriptions, sections } = parseIndexLinks(parsedIndex.body);

  const okfVersion = String(fm.okf_version || '0.2');
  const title = String(fm.title || extractedIndex.title || fallbackName);
  const description = String(fm.description || extractedIndex.summary || '');

  const allMdFiles = walkMarkdownFiles(bundleDir);
  const normBundleDir = normalizePath(bundleDir);
  const concepts = [];

  for (const absFile of allMdFiles) {
    const relPath = absFile.startsWith(`${normBundleDir}/`)
      ? absFile.slice(normBundleDir.length + 1)
      : path.basename(absFile);
    const baseLower = path.basename(relPath).toLowerCase();
    if (baseLower === 'index.md' || baseLower === 'log.md') {
      continue;
    }

    let raw = '';
    try {
      raw = fs.readFileSync(absFile, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseFrontmatter(raw);
    const cfm = parsed.frontmatter || {};
    const linkInfo = linkDescriptions.get(relPath) || null;
    const stem = path.basename(relPath, path.extname(relPath));
    const headingInfo = extractFirstHeadingAndSummary(parsed.body, linkInfo?.label || stem);

    const conceptTitle = String(cfm.title || linkInfo?.label || headingInfo.title || stem);
    const conceptDesc = String(cfm.description || linkInfo?.description || headingInfo.summary || '');
    const conceptType = String(
      cfm.type ||
        cfm.category ||
        (relPath.includes('/') ? relPath.split('/')[0].replace(/s$/, '') : 'concept')
    ).toLowerCase();
    const tags = Array.isArray(cfm.tags)
      ? cfm.tags.map((t) => String(t).trim()).filter(Boolean)
      : typeof cfm.tags === 'string' && cfm.tags
        ? cfm.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [];
    const fmFiles = Array.isArray(cfm.files)
      ? cfm.files
      : Array.isArray(cfm.file_paths)
        ? cfm.file_paths
        : [];
    const filePaths = [
      ...new Set([...fmFiles.map((f) => String(f).trim()).filter(Boolean), ...extractCodeFileRefs(parsed.body)]),
    ];

    concepts.push({
      id: String(cfm.key || slugify(relPath.replace(/\.(md|markdown)$/i, ''), stem)),
      rel_path: relPath,
      repo_path: toRepoRelative(absFile, workspaceDir),
      abs_path: absFile,
      type: conceptType,
      category: inferCategoryFromTypeOrTitle(cfm.category || conceptType || conceptTitle),
      title: conceptTitle,
      description: conceptDesc,
      resource: cfm.resource ? String(cfm.resource) : '',
      tags,
      file_paths: filePaths,
      inject_mode: MEMORY_INJECT_MODES.includes(String(cfm.inject_mode || ''))
        ? String(cfm.inject_mode)
        : filePaths.length > 0
          ? 'on_demand'
          : 'always',
      confidence: MEMORY_CONFIDENCES.includes(String(cfm.confidence || ''))
        ? String(cfm.confidence)
        : 'confirmed',
      section: linkInfo?.section || (relPath.includes('/') ? relPath.split('/')[0] : 'General'),
      timestamp: cfm.timestamp ? String(cfm.timestamp) : '',
      body_preview: parsed.body.replace(/\s+/g, ' ').trim().slice(0, 360),
    });
  }

  return {
    configured: true,
    enabled: kpMode !== 'disabled',
    exists: true,
    format: 'okf',
    kp_path: kpPath,
    kp_mode: kpMode,
    resolved_path: normBundleDir,
    repo_path: toRepoRelative(normBundleDir, workspaceDir),
    index_path: normalizePath(indexFilePath),
    index_repo_path: toRepoRelative(indexFilePath, workspaceDir),
    has_index: hasIndex,
    okf_version: okfVersion,
    title,
    description,
    sections,
    concepts,
    index_preview: parsedIndex.body.trim().slice(0, 1800),
  };
}

function parseMarkdownSections(markdownBody, docTitle) {
  const lines = String(markdownBody || '').split('\n');
  const sections = [];
  let current = null;
  let inFence = false;

  const flush = () => {
    if (!current) return;
    const bodyText = current.lines.join('\n').trim();
    const compact = bodyText.replace(/\s+/g, ' ').trim();
    if (current.heading && compact) {
      sections.push({
        id: slugify(current.heading, `sec-${sections.length + 1}`),
        level: current.level,
        heading: current.heading,
        category: inferCategoryFromTypeOrTitle(current.heading),
        content_preview: compact.slice(0, 420),
        file_paths: extractCodeFileRefs(bodyText),
      });
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
    }
    if (!inFence) {
      const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (h) {
        flush();
        current = {
          level: h[1].length,
          heading: h[2].trim(),
          lines: [],
        };
        continue;
      }
    }
    if (!current) {
      if (!trimmed) continue;
      current = {
        level: 1,
        heading: docTitle || 'Overview',
        lines: [],
      };
    }
    current.lines.push(rawLine);
  }
  flush();
  return sections;
}

function inspectSingleMarkdown({ filePath, kpPath, kpMode, workspaceDir }) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    raw = '';
  }
  const parsed = parseFrontmatter(raw);
  const fm = parsed.frontmatter || {};
  const fallbackTitle = path.basename(filePath, path.extname(filePath)) || 'Knowledge Pack';
  const extracted = extractFirstHeadingAndSummary(parsed.body, fallbackTitle);
  const title = String(fm.title || extracted.title || fallbackTitle);
  const description = String(fm.description || extracted.summary || '');
  const tags = Array.isArray(fm.tags)
    ? fm.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const sections = parseMarkdownSections(parsed.body, title);

  return {
    configured: true,
    enabled: kpMode !== 'disabled',
    exists: true,
    format: 'markdown',
    kp_path: kpPath,
    kp_mode: kpMode,
    resolved_path: normalizePath(filePath),
    repo_path: toRepoRelative(filePath, workspaceDir),
    title,
    description,
    tags,
    sections,
    content_preview: parsed.body.trim().slice(0, 2000),
  };
}

/**
 * Inspect a project's configured Knowledge Pack (supports OKF directory/index.md and single Markdown file).
 */
export function inspectKnowledgePack(project) {
  const kpPath = String(project?.kp_path || '').trim();
  const kpMode = KP_MODES.includes(project?.kp_mode) ? project.kp_mode : 'auto';
  const workspaceDir = String(project?.workspace_dir || '').trim();

  if (!kpPath) {
    return {
      configured: false,
      enabled: kpMode !== 'disabled',
      exists: false,
      format: null,
      kp_path: '',
      kp_mode: kpMode,
      resolved_path: '',
      repo_path: '',
      title: '',
      description: '',
      concepts: [],
      sections: [],
    };
  }

  const absPath = resolveKpAbsolutePath(kpPath, workspaceDir);
  if (!absPath || !fs.existsSync(absPath)) {
    const inferredFormat =
      kpMode === 'okf' || kpMode === 'markdown'
        ? kpMode
        : path.basename(absPath).toLowerCase() === 'index.md' || !/\.(md|markdown)$/i.test(absPath)
          ? 'okf'
          : 'markdown';
    return {
      configured: true,
      enabled: kpMode !== 'disabled',
      exists: false,
      format: inferredFormat,
      kp_path: kpPath,
      kp_mode: kpMode,
      resolved_path: absPath,
      repo_path: toRepoRelative(absPath, workspaceDir),
      title: path.basename(absPath) || kpPath,
      description: '',
      concepts: [],
      sections: [],
    };
  }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return {
      configured: true,
      enabled: kpMode !== 'disabled',
      exists: false,
      format: null,
      kp_path: kpPath,
      kp_mode: kpMode,
      resolved_path: absPath,
      repo_path: toRepoRelative(absPath, workspaceDir),
      title: path.basename(absPath),
      description: '',
      concepts: [],
      sections: [],
    };
  }

  if (stat.isDirectory()) {
    const indexFilePath = path.join(absPath, 'index.md');
    return inspectOkfBundle({
      bundleDir: absPath,
      indexFilePath,
      kpPath,
      kpMode,
      workspaceDir,
    });
  }

  // File on disk: check if it's an OKF index.md or has okf_version frontmatter
  const baseLower = path.basename(absPath).toLowerCase();
  if (kpMode === 'okf' || (kpMode === 'auto' && baseLower === 'index.md')) {
    return inspectOkfBundle({
      bundleDir: path.dirname(absPath),
      indexFilePath: absPath,
      kpPath,
      kpMode,
      workspaceDir,
    });
  }

  if (kpMode === 'auto') {
    try {
      const headChunk = fs.readFileSync(absPath, 'utf8').slice(0, 600);
      const parsed = parseFrontmatter(headChunk);
      if (parsed.hasFrontmatter && parsed.frontmatter.okf_version) {
        return inspectOkfBundle({
          bundleDir: path.dirname(absPath),
          indexFilePath: absPath,
          kpPath,
          kpMode,
          workspaceDir,
        });
      }
    } catch {
      // fall through to single markdown
    }
  }

  return inspectSingleMarkdown({
    filePath: absPath,
    kpPath,
    kpMode,
    workspaceDir,
  });
}

function pathsMatch(aRaw, bRaw) {
  const a = String(aRaw || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const b = String(bRaw || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Format concise Knowledge Pack context for [WORK PLAN] PreInvocation turn briefs.
 */
export function selectKnowledgePackForBrief(project, { taskFiles = [], maxChars = 1200 } = {}) {
  const kp = inspectKnowledgePack(project);
  if (!kp.configured || !kp.enabled || !kp.exists) {
    return { active: false, format: null, lines: [] };
  }

  const normTaskFiles = Array.isArray(taskFiles) ? taskFiles.filter(Boolean) : [];
  const lines = [];

  if (kp.format === 'okf') {
    const loc = kp.index_repo_path || kp.repo_path || kp.resolved_path;
    lines.push(
      `Knowledge Pack (OKF v${kp.okf_version}): ${loc} — "${kp.title}" (${kp.concepts.length} concept${kp.concepts.length === 1 ? '' : 's'})`
    );

    const ranked = [...kp.concepts].sort((a, b) => {
      const aHit = normTaskFiles.some(
        (tf) =>
          pathsMatch(a.rel_path, tf) ||
          a.file_paths.some((fp) => pathsMatch(fp, tf))
      );
      const bHit = normTaskFiles.some(
        (tf) =>
          pathsMatch(b.rel_path, tf) ||
          b.file_paths.some((fp) => pathsMatch(fp, tf))
      );
      if (aHit !== bHit) return aHit ? -1 : 1;
      return a.rel_path.localeCompare(b.rel_path);
    });

    let used = lines[0].length;
    for (const c of ranked.slice(0, 8)) {
      const desc = (c.description || c.body_preview || '').slice(0, 180);
      const entry = `- [${c.type}] ${c.title} (${c.rel_path})${desc ? `: ${desc}` : ''}`;
      if (used + entry.length > maxChars) break;
      lines.push(entry);
      used += entry.length + 1;
    }
    return { active: true, format: 'okf', lines };
  }

  const loc = kp.repo_path || kp.resolved_path;
  lines.push(
    `Knowledge Pack (Markdown): ${loc} — "${kp.title}" (${kp.sections.length} section${kp.sections.length === 1 ? '' : 's'})`
  );
  const rankedSections = [...kp.sections].sort((a, b) => {
    const aHit = normTaskFiles.some((tf) => a.file_paths?.some((fp) => pathsMatch(fp, tf)));
    const bHit = normTaskFiles.some((tf) => b.file_paths?.some((fp) => pathsMatch(fp, tf)));
    if (aHit !== bHit) return aHit ? -1 : 1;
    return 0;
  });

  let used = lines[0].length;
  for (const s of rankedSections.slice(0, 6)) {
    const preview = (s.content_preview || '').slice(0, 180);
    const entry = `- ${s.heading}${preview ? `: ${preview}` : ''}`;
    if (used + entry.length > maxChars) break;
    lines.push(entry);
    used += entry.length + 1;
  }

  return { active: true, format: 'markdown', lines };
}

/**
 * Import concepts (OKF) or sections (Single Markdown) from the project's Knowledge Pack into ProjectMemories.
 */
export function importKnowledgePackToMemories(db, project, { item_id = null } = {}) {
  const kp = inspectKnowledgePack(project);
  if (!kp.configured || !kp.exists) {
    throw new WorkPlanError(
      'KP_NOT_FOUND',
      kp.kp_path
        ? `Knowledge Pack path "${kp.kp_path}" does not exist on disk.`
        : 'No Knowledge Pack path is configured for this project.'
    );
  }

  const imported = [];
  if (kp.format === 'okf') {
    const targets = item_id
      ? kp.concepts.filter((c) => c.id === item_id || c.rel_path === item_id)
      : kp.concepts;
    for (const c of targets) {
      const bodyText = c.description || c.body_preview || `OKF ${c.type} concept at ${c.rel_path}`;
      const content = c.resource ? `${bodyText}\nResource: ${c.resource}` : bodyText;
      const saved = saveMemory(db, project.project_id, {
        key: `okf-${slugify(c.id || c.rel_path, 'concept')}`,
        title: c.title,
        content,
        category: c.category || inferCategoryFromTypeOrTitle(c.type || c.title),
        tags: [...new Set(['okf', ...(c.type ? [c.type] : []), ...(c.tags || [])])],
        file_paths: [...new Set([...(c.file_paths || []), c.repo_path || c.rel_path].filter(Boolean))],
        inject_mode: c.inject_mode || 'always',
        confidence: c.confidence || 'confirmed',
        source: 'file',
      });
      imported.push(saved);
    }
  } else {
    const targets = item_id
      ? kp.sections.filter((s) => s.id === item_id || s.heading === item_id)
      : kp.sections;
    for (const s of targets) {
      if (!s.content_preview && targets.length > 1) continue;
      const saved = saveMemory(db, project.project_id, {
        key: `kp-${slugify(s.id || s.heading, 'section')}`,
        title: s.heading,
        content: s.content_preview || kp.description || `Section from ${kp.repo_path || kp.kp_path}`,
        category: s.category || inferCategoryFromTypeOrTitle(s.heading),
        tags: [...new Set(['kp', ...(kp.tags || [])])],
        file_paths: [...new Set([...(s.file_paths || []), kp.repo_path].filter(Boolean))],
        inject_mode: 'always',
        confidence: 'confirmed',
        source: 'file',
      });
      imported.push(saved);
    }
  }

  return {
    format: kp.format,
    kp_path: kp.kp_path,
    imported_count: imported.length,
    memories: imported,
  };
}

function yamlEscape(val) {
  const s = String(val ?? '').replace(/\r?\n/g, ' ').trim();
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Export active ProjectMemories to disk as an OKF v0.2 bundle or a Single Markdown file.
 */
export function exportMemoriesToKnowledgePack(
  db,
  project,
  { format = 'okf', target_path = '' } = {}
) {
  const outFormat = format === 'markdown' ? 'markdown' : 'okf';
  const workspaceDir = String(project?.workspace_dir || '').trim();
  const memories = listMemories(db, project.project_id).filter((m) => m.inject_mode !== 'disabled');
  const now = nowIso();

  let rawTarget = String(target_path || project?.kp_path || '').trim();
  if (!rawTarget) {
    rawTarget = outFormat === 'okf' ? 'knowledge' : 'KNOWLEDGE.md';
  }

  let absTarget = resolveKpAbsolutePath(rawTarget, workspaceDir);
  if (!absTarget) {
    throw new WorkPlanError('VALIDATION_ERROR', 'Unable to resolve target path for Knowledge Pack export.');
  }

  if (outFormat === 'okf') {
    const bundleDir =
      path.basename(absTarget).toLowerCase() === 'index.md'
        ? path.dirname(absTarget)
        : /\.(md|markdown)$/i.test(absTarget)
          ? absTarget.replace(/\.(md|markdown)$/i, '')
          : absTarget;

    fs.mkdirSync(bundleDir, { recursive: true });
    const indexLines = [
      '---',
      'okf_version: "0.2"',
      `title: ${yamlEscape(`${project.title} Knowledge Pack`)}`,
      `description: ${yamlEscape(`Open Knowledge Format (OKF) bundle for ${project.title}`)}`,
      '---',
      '',
      `# ${project.title} Knowledge Pack`,
    ];

    const writtenFiles = [];
    const usedRelPaths = new Set();

    for (const cat of MEMORY_CATEGORIES) {
      const group = memories.filter((m) => m.category === cat);
      if (group.length === 0) continue;

      const heading = cat.charAt(0).toUpperCase() + cat.slice(1);
      indexLines.push('', `## ${heading}`);
      const catDir = path.join(bundleDir, cat);
      fs.mkdirSync(catDir, { recursive: true });

      for (const m of group) {
        const baseSlug = slugify(m.key || m.title, 'concept');
        let relPath = `${cat}/${baseSlug}.md`;
        let counter = 2;
        while (usedRelPaths.has(relPath)) {
          relPath = `${cat}/${baseSlug}-${counter}.md`;
          counter += 1;
        }
        usedRelPaths.add(relPath);

        const summary = m.content.replace(/\s+/g, ' ').trim().slice(0, 180);
        indexLines.push(`* [${m.title}](${relPath}) - ${summary}`);

        const conceptLines = [
          '---',
          `type: ${cat}`,
          `title: ${yamlEscape(m.title)}`,
          `description: ${yamlEscape(summary)}`,
          ...(m.key ? [`key: ${yamlEscape(m.key)}`] : []),
          `inject_mode: ${yamlEscape(m.inject_mode)}`,
          `confidence: ${yamlEscape(m.confidence)}`,
          ...(m.tags?.length ? [`tags: [${m.tags.map((t) => yamlEscape(t)).join(', ')}]`] : []),
          ...(m.file_paths?.length
            ? [`files: [${m.file_paths.map((f) => yamlEscape(f)).join(', ')}]`]
            : []),
          `timestamp: ${now}`,
          '---',
          '',
          `# ${m.title}`,
          '',
          m.content.trim(),
          '',
        ];

        const conceptAbs = path.join(bundleDir, relPath);
        fs.writeFileSync(conceptAbs, conceptLines.join('\n'), 'utf8');
        writtenFiles.push(normalizePath(conceptAbs));
      }
    }

    if (memories.length === 0) {
      indexLines.push('', '_(No active memories exported yet.)_');
    }
    indexLines.push('');

    const indexAbs = path.join(bundleDir, 'index.md');
    fs.writeFileSync(indexAbs, indexLines.join('\n'), 'utf8');
    writtenFiles.unshift(normalizePath(indexAbs));

    const logAbs = path.join(bundleDir, 'log.md');
    const logLine = `- **${now}**: Exported ${memories.length} concept(s) from Work Plan Knowledge.\n`;
    const prevLog = fs.existsSync(logAbs) ? fs.readFileSync(logAbs, 'utf8') : '# Knowledge Pack Changelog\n\n';
    fs.writeFileSync(logAbs, prevLog + logLine, 'utf8');
    writtenFiles.push(normalizePath(logAbs));

    const normBundle = normalizePath(bundleDir);
    return {
      format: 'okf',
      exported_count: memories.length,
      written_path: normBundle,
      repo_path: toRepoRelative(normBundle, workspaceDir),
      files_written: writtenFiles,
    };
  }

  // Single Markdown file export
  const mdFile =
    fs.existsSync(absTarget) && fs.statSync(absTarget).isDirectory()
      ? path.join(absTarget, 'KNOWLEDGE.md')
      : /\.(md|markdown)$/i.test(absTarget)
        ? absTarget
        : `${absTarget}.md`;

  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  const lines = [
    '---',
    `title: ${yamlEscape(`${project.title} — Knowledge Pack`)}`,
    `description: ${yamlEscape(`Project knowledge and conventions for ${project.title}`)}`,
    `updated_at: ${now}`,
    '---',
    '',
    `# ${project.title} — Knowledge Pack`,
  ];

  for (const cat of MEMORY_CATEGORIES) {
    const group = memories.filter((m) => m.category === cat);
    if (group.length === 0) continue;
    lines.push('', `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
    for (const m of group) {
      lines.push('', `### ${m.title}`, '', m.content.trim());
      const meta = [];
      if (m.key) meta.push(`key: \`${m.key}\``);
      if (m.inject_mode === 'on_demand') meta.push('inject: `on_demand`');
      if (m.file_paths?.length) meta.push(`files: ${m.file_paths.map((f) => `\`${f}\``).join(', ')}`);
      if (m.tags?.length) meta.push(`tags: ${m.tags.map((t) => `#${t}`).join(' ')}`);
      if (meta.length > 0) {
        lines.push('', `> ${meta.join(' · ')}`);
      }
    }
  }

  if (memories.length === 0) {
    lines.push('', '_(No active knowledge entries recorded yet.)_');
  }
  lines.push('');

  fs.writeFileSync(mdFile, lines.join('\n'), 'utf8');
  const normFile = normalizePath(mdFile);
  return {
    format: 'markdown',
    exported_count: memories.length,
    written_path: normFile,
    repo_path: toRepoRelative(normFile, workspaceDir),
    files_written: [normFile],
  };
}
