import crypto from 'node:crypto';
import { nowIso, withTransaction, WorkPlanError } from './db.mjs';
import { slugify } from './sources.mjs';

export const MEMORY_CATEGORIES = [
  'architecture',
  'convention',
  'command',
  'constraint',
  'pitfall',
  'context',
  'fact',
];
export const MEMORY_INJECT_MODES = ['always', 'on_demand', 'disabled'];
export const MEMORY_CONFIDENCES = ['confirmed', 'inferred', 'stale'];
export const MEMORY_SOURCES = ['user', 'agent', 'file'];

const INJECT_ORDER = { always: 0, on_demand: 1, disabled: 2 };
const CONFIDENCE_ORDER = { confirmed: 0, inferred: 1, stale: 2 };

function normalizeEnum(value, allowed, fieldName, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const clean = String(value).trim().toLowerCase();
  if (!allowed.includes(clean)) {
    throw new WorkPlanError(
      'VALIDATION_ERROR',
      `Invalid ${fieldName} "${value}". Expected one of: ${allowed.join(', ')}.`
    );
  }
  return clean;
}

function normalizeMemoryPath(raw) {
  let s = String(raw || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  if (s.startsWith('./')) s = s.slice(2);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function normalizeStringList(raw, { lowercase = false, isPath = false } = {}) {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\n]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    let val = isPath ? normalizeMemoryPath(item) : String(item || '').trim();
    if (!val) continue;
    if (lowercase) val = val.toLowerCase();
    if (!seen.has(val)) {
      seen.add(val);
      out.push(val);
    }
  }
  return out;
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatMemoryRow(row) {
  if (!row) return null;
  return {
    memory_id: row.memory_id,
    project_id: row.project_id,
    category: row.category,
    key: row.key || '',
    title: row.title,
    content: row.content,
    tags: parseJsonArray(row.tags_json),
    file_paths: parseJsonArray(row.file_paths_json),
    inject_mode: row.inject_mode,
    confidence: row.confidence,
    source: row.source,
    source_conv_id: row.source_conv_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Create or update a durable project memory entry (idempotent when matching memory_id or key).
 */
export function saveMemory(
  db,
  projectId,
  {
    memory_id,
    key = '',
    title,
    content,
    category = 'fact',
    tags = [],
    file_paths = [],
    inject_mode = 'always',
    confidence = 'confirmed',
    source = 'user',
    source_conv_id = null,
  } = {}
) {
  const cleanTitle = String(title || '').trim();
  const cleanContent = String(content ?? '').trim();
  if (!cleanTitle) {
    throw new WorkPlanError('VALIDATION_ERROR', 'Memory title is required.');
  }
  if (!cleanContent) {
    throw new WorkPlanError('VALIDATION_ERROR', 'Memory content is required.');
  }

  const normCategory = normalizeEnum(category, MEMORY_CATEGORIES, 'category', 'fact');
  const normInject = normalizeEnum(inject_mode, MEMORY_INJECT_MODES, 'inject_mode', 'always');
  const normConfidence = normalizeEnum(confidence, MEMORY_CONFIDENCES, 'confidence', 'confirmed');
  const normSource = normalizeEnum(source, MEMORY_SOURCES, 'source', 'user');

  const rawKey = String(key || '').trim();
  const normKey = rawKey ? slugify(rawKey, '') : '';
  const normTags = normalizeStringList(tags, { lowercase: true });
  const normFilePaths = normalizeStringList(file_paths, { isPath: true });
  const requestedId = memory_id ? String(memory_id).trim() : '';

  return withTransaction(db, () => {
    const project = db.prepare('SELECT project_id FROM Projects WHERE project_id = ?').get(projectId);
    if (!project) {
      throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${projectId}" does not exist.`);
    }

    const now = nowIso();
    let existing = null;

    if (requestedId) {
      existing = db
        .prepare('SELECT * FROM ProjectMemories WHERE memory_id = ? AND project_id = ?')
        .get(requestedId, projectId);
    }

    if (existing) {
      if (normKey) {
        const conflict = db
          .prepare('SELECT memory_id FROM ProjectMemories WHERE project_id = ? AND key = ? AND memory_id != ?')
          .get(projectId, normKey, existing.memory_id);
        if (conflict) {
          throw new WorkPlanError(
            'DUPLICATE_MEMORY_KEY',
            `Memory key "${normKey}" already exists in project "${projectId}".`
          );
        }
      }
      db.prepare(
        `UPDATE ProjectMemories
         SET category = ?, key = ?, title = ?, content = ?, tags_json = ?, file_paths_json = ?,
             inject_mode = ?, confidence = ?, source = ?, source_conv_id = ?, updated_at = ?
         WHERE memory_id = ?`
      ).run(
        normCategory,
        normKey,
        cleanTitle,
        cleanContent,
        JSON.stringify(normTags),
        JSON.stringify(normFilePaths),
        normInject,
        normConfidence,
        normSource,
        source_conv_id || existing.source_conv_id || null,
        now,
        existing.memory_id
      );
      db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
      return formatMemoryRow(
        db.prepare('SELECT * FROM ProjectMemories WHERE memory_id = ?').get(existing.memory_id)
      );
    }

    if (normKey) {
      const byKey = db
        .prepare('SELECT * FROM ProjectMemories WHERE project_id = ? AND key = ?')
        .get(projectId, normKey);
      if (byKey) {
        db.prepare(
          `UPDATE ProjectMemories
           SET category = ?, title = ?, content = ?, tags_json = ?, file_paths_json = ?,
               inject_mode = ?, confidence = ?, source = ?, source_conv_id = ?, updated_at = ?
           WHERE memory_id = ?`
        ).run(
          normCategory,
          cleanTitle,
          cleanContent,
          JSON.stringify(normTags),
          JSON.stringify(normFilePaths),
          normInject,
          normConfidence,
          normSource,
          source_conv_id || byKey.source_conv_id || null,
          now,
          byKey.memory_id
        );
        db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
        return formatMemoryRow(
          db.prepare('SELECT * FROM ProjectMemories WHERE memory_id = ?').get(byKey.memory_id)
        );
      }
    }

    const targetId =
      requestedId || `mem-${slugify(normKey || cleanTitle, 'entry')}-${crypto.randomBytes(3).toString('hex')}`;

    db.prepare(
      `INSERT INTO ProjectMemories (
         memory_id, project_id, category, key, title, content, tags_json, file_paths_json,
         inject_mode, confidence, source, source_conv_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      targetId,
      projectId,
      normCategory,
      normKey,
      cleanTitle,
      cleanContent,
      JSON.stringify(normTags),
      JSON.stringify(normFilePaths),
      normInject,
      normConfidence,
      normSource,
      source_conv_id || null,
      now,
      now
    );
    db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
    return formatMemoryRow(db.prepare('SELECT * FROM ProjectMemories WHERE memory_id = ?').get(targetId));
  });
}

/**
 * List and filter project memories, sorted by inject_mode, confidence, then updated_at desc.
 */
export function listMemories(
  db,
  projectId,
  { query = '', category = '', inject_mode = '', confidence = '', tag = '', file_path = '' } = {}
) {
  const cleanCategory = category ? normalizeEnum(category, MEMORY_CATEGORIES, 'category', '') : '';
  const cleanInject = inject_mode ? normalizeEnum(inject_mode, MEMORY_INJECT_MODES, 'inject_mode', '') : '';
  const cleanConfidence = confidence ? normalizeEnum(confidence, MEMORY_CONFIDENCES, 'confidence', '') : '';
  const cleanTag = String(tag || '').trim().toLowerCase();
  const cleanFile = normalizeMemoryPath(file_path).toLowerCase();
  const cleanQuery = String(query || '').trim().toLowerCase();

  const rows = db.prepare('SELECT * FROM ProjectMemories WHERE project_id = ?').all(projectId);
  let items = rows.map(formatMemoryRow);

  if (cleanCategory) {
    items = items.filter((m) => m.category === cleanCategory);
  }
  if (cleanInject) {
    items = items.filter((m) => m.inject_mode === cleanInject);
  }
  if (cleanConfidence) {
    items = items.filter((m) => m.confidence === cleanConfidence);
  }
  if (cleanTag) {
    items = items.filter((m) => m.tags.some((t) => t.toLowerCase() === cleanTag));
  }
  if (cleanFile) {
    items = items.filter((m) =>
      m.file_paths.some((fp) => {
        const lower = fp.toLowerCase();
        return (
          lower === cleanFile ||
          lower.includes(cleanFile) ||
          cleanFile.startsWith(`${lower}/`) ||
          lower.startsWith(`${cleanFile}/`)
        );
      })
    );
  }
  if (cleanQuery) {
    items = items.filter(
      (m) =>
        m.title.toLowerCase().includes(cleanQuery) ||
        m.content.toLowerCase().includes(cleanQuery) ||
        m.key.toLowerCase().includes(cleanQuery) ||
        m.tags.some((t) => t.toLowerCase().includes(cleanQuery)) ||
        m.file_paths.some((f) => f.toLowerCase().includes(cleanQuery))
    );
  }

  items.sort((a, b) => {
    const ia = INJECT_ORDER[a.inject_mode] ?? 9;
    const ib = INJECT_ORDER[b.inject_mode] ?? 9;
    if (ia !== ib) return ia - ib;
    const ca = CONFIDENCE_ORDER[a.confidence] ?? 9;
    const cb = CONFIDENCE_ORDER[b.confidence] ?? 9;
    if (ca !== cb) return ca - cb;
    return b.updated_at.localeCompare(a.updated_at);
  });

  return items;
}

/**
 * Delete a memory by memory_id or key within a project.
 */
export function deleteMemory(db, projectId, memoryIdOrKey) {
  const clean = String(memoryIdOrKey || '').trim();
  if (!clean) return false;
  const slugKey = slugify(clean, '');

  return withTransaction(db, () => {
    const info = db
      .prepare(
        `DELETE FROM ProjectMemories
         WHERE project_id = ? AND (memory_id = ? OR (key != '' AND (key = ? OR key = ?)))`
      )
      .run(projectId, clean, clean, slugKey);
    if (info.changes > 0) {
      db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(nowIso(), projectId);
      return true;
    }
    return false;
  });
}

function pathsOverlap(aRaw, bRaw) {
  const a = normalizeMemoryPath(aRaw).toLowerCase();
  const b = normalizeMemoryPath(bRaw).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a === '.' || b === '.') return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Select active, non-stale memories for [WORK PLAN] PreInvocation brief injection.
 */
export function selectMemoriesForBrief(
  db,
  projectId,
  { taskFiles = [], maxAlways = 8, maxContextual = 4, maxTotalChars = 1800 } = {}
) {
  const all = listMemories(db, projectId).filter(
    (m) => m.inject_mode !== 'disabled' && m.confidence !== 'stale'
  );

  const alwaysCandidates = all.filter((m) => m.inject_mode === 'always').slice(0, maxAlways);

  const normTaskFiles = Array.isArray(taskFiles) ? taskFiles.filter(Boolean) : [];
  const contextualCandidates =
    normTaskFiles.length > 0
      ? all
          .filter(
            (m) =>
              m.inject_mode === 'on_demand' &&
              m.file_paths.some((fp) => normTaskFiles.some((tf) => pathsOverlap(fp, tf)))
          )
          .slice(0, maxContextual)
      : [];

  const always = [];
  const contextual = [];
  const items = [];
  let usedChars = 0;

  const tryPush = (mem, bucket) => {
    const compact = mem.content.replace(/\s+/g, ' ').trim();
    const snippet = compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
    const line = `- [${mem.category}] ${mem.title}: ${snippet}`;
    if (usedChars + line.length > maxTotalChars) {
      if (items.length > 0) return false;
      const avail = maxTotalChars - (`- [${mem.category}] ${mem.title}: `.length + 3);
      if (avail <= 0) return false;
      const clipped = { ...mem, snippet: `${compact.slice(0, avail)}...` };
      usedChars += `- [${mem.category}] ${mem.title}: ${clipped.snippet}`.length;
      bucket.push(clipped);
      items.push(clipped);
      return true;
    }
    usedChars += line.length + 1;
    const entry = { ...mem, snippet };
    bucket.push(entry);
    items.push(entry);
    return true;
  };

  for (const m of alwaysCandidates) {
    if (!tryPush(m, always)) break;
  }
  for (const m of contextualCandidates) {
    if (!tryPush(m, contextual)) break;
  }

  return { always, contextual, items };
}

/**
 * Format active (non-disabled) project memories as grouped Markdown for export.
 */
export function exportMemoriesMarkdown(project, memories = []) {
  const active = (Array.isArray(memories) ? memories : []).filter((m) => m.inject_mode !== 'disabled');
  const title = project?.title ? `${project.title} — Project Memory` : 'Project Memory';
  if (active.length === 0) {
    return `# ${title}\n\n_(No active project memories recorded yet.)_\n`;
  }

  const lines = [`# ${title}`];
  for (const cat of MEMORY_CATEGORIES) {
    const group = active.filter((m) => m.category === cat);
    if (group.length === 0) continue;
    lines.push('', `## ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
    for (const m of group) {
      const meta = [];
      if (m.key) meta.push(`key: \`${m.key}\``);
      if (m.inject_mode === 'on_demand') meta.push('inject: on-demand');
      if (m.confidence !== 'confirmed') meta.push(`confidence: ${m.confidence}`);
      if (m.file_paths?.length) meta.push(`files: ${m.file_paths.map((f) => `\`${f}\``).join(', ')}`);
      if (m.tags?.length) meta.push(`tags: ${m.tags.map((t) => `#${t}`).join(' ')}`);
      lines.push(`- **${m.title}**${meta.length ? ` (${meta.join(' · ')})` : ''}: ${m.content}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
