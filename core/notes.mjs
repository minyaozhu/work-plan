import crypto from 'node:crypto';
import { nowIso, withTransaction, WorkPlanError } from './db.mjs';
import { slugify } from './sources.mjs';

export const NOTE_KINDS = ['decision', 'gotcha', 'spec', 'note'];

function normalizeKind(kind) {
  const val = String(kind || 'note').trim().toLowerCase();
  if (!NOTE_KINDS.includes(val)) {
    throw new WorkPlanError(
      'VALIDATION_ERROR',
      `Invalid note kind "${kind}". Expected one of: ${NOTE_KINDS.join(', ')}.`,
      'Pass kind as "decision", "gotcha", "spec", or "note".'
    );
  }
  return val;
}

function formatNoteRow(row) {
  if (!row) return null;
  return {
    note_id: row.note_id,
    project_id: row.project_id,
    task_id: row.task_id || null,
    kind: row.kind,
    title: row.title,
    body_markdown: row.body_markdown,
    pinned: Boolean(row.pinned),
    source_conv_id: row.source_conv_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Create or update a project/task working note.
 */
export function saveNote(
  db,
  projectId,
  { note_id, title, body_markdown, kind = 'note', task_id = null, pinned = false, source_conv_id = null }
) {
  const cleanTitle = String(title || '').trim();
  const cleanBody = String(body_markdown ?? '').trim();
  if (!cleanTitle) {
    throw new WorkPlanError('VALIDATION_ERROR', 'Note title is required.');
  }
  const normalizedKind = normalizeKind(kind);
  const cleanTaskId = task_id ? String(task_id).trim() : null;

  return withTransaction(db, () => {
    const project = db.prepare('SELECT project_id FROM Projects WHERE project_id = ?').get(projectId);
    if (!project) {
      throw new WorkPlanError('PROJECT_NOT_FOUND', `Project "${projectId}" does not exist.`);
    }

    if (cleanTaskId) {
      const task = db
        .prepare('SELECT task_id FROM Tasks WHERE project_id = ? AND task_id = ?')
        .get(projectId, cleanTaskId);
      if (!task) {
        throw new WorkPlanError(
          'TASK_NOT_FOUND',
          `Task "${cleanTaskId}" does not exist in project "${projectId}".`
        );
      }
    }

    const now = nowIso();
    let targetNoteId = note_id ? String(note_id).trim() : '';

    if (targetNoteId) {
      const existing = db
        .prepare('SELECT * FROM ProjectNotes WHERE note_id = ? AND project_id = ?')
        .get(targetNoteId, projectId);
      if (existing) {
        db.prepare(
          `UPDATE ProjectNotes
           SET task_id = ?, kind = ?, title = ?, body_markdown = ?, pinned = ?, updated_at = ?
           WHERE note_id = ?`
        ).run(cleanTaskId, normalizedKind, cleanTitle, cleanBody, pinned ? 1 : 0, now, targetNoteId);
        db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
        return formatNoteRow(db.prepare('SELECT * FROM ProjectNotes WHERE note_id = ?').get(targetNoteId));
      }
    } else {
      const suffix = crypto.randomBytes(3).toString('hex');
      targetNoteId = `note-${slugify(cleanTitle, 'entry')}-${suffix}`;
    }

    db.prepare(
      `INSERT INTO ProjectNotes (
         note_id, project_id, task_id, kind, title, body_markdown, pinned, source_conv_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      targetNoteId,
      projectId,
      cleanTaskId,
      normalizedKind,
      cleanTitle,
      cleanBody,
      pinned ? 1 : 0,
      source_conv_id || null,
      now,
      now
    );
    db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(now, projectId);
    return formatNoteRow(db.prepare('SELECT * FROM ProjectNotes WHERE note_id = ?').get(targetNoteId));
  });
}

/**
 * List/search project notes, ranking pinned and task-scoped notes first.
 */
export function listNotes(db, projectId, { query = '', kind = '', task_id = null, task_scope_only = false } = {}) {
  const cleanKind = kind ? normalizeKind(kind) : '';
  const cleanQuery = String(query || '').trim().toLowerCase();
  const cleanTaskId = task_id ? String(task_id).trim() : null;

  const rows = db
    .prepare('SELECT * FROM ProjectNotes WHERE project_id = ? ORDER BY pinned DESC, updated_at DESC')
    .all(projectId);

  const ancestorIds = new Set();
  if (cleanTaskId) {
    const taskRows = db
      .prepare('SELECT task_id, parent_id FROM Tasks WHERE project_id = ?')
      .all(projectId);
    const parentMap = new Map(taskRows.map((r) => [r.task_id, r.parent_id]));
    let cur = parentMap.get(cleanTaskId);
    while (cur && !ancestorIds.has(cur)) {
      ancestorIds.add(cur);
      cur = parentMap.get(cur);
    }
  }

  let notes = rows.map(formatNoteRow);

  if (cleanKind) {
    notes = notes.filter((n) => n.kind === cleanKind);
  }
  if (task_scope_only && cleanTaskId) {
    if (cleanTaskId === '__project__') {
      notes = notes.filter((n) => !n.task_id);
    } else {
      notes = notes.filter((n) => n.task_id === cleanTaskId);
    }
  }
  if (cleanQuery) {
    notes = notes.filter(
      (n) =>
        n.title.toLowerCase().includes(cleanQuery) ||
        n.body_markdown.toLowerCase().includes(cleanQuery)
    );
  }

  const scoreScope = (n) => {
    if (!cleanTaskId) return n.task_id ? 1 : 0;
    if (n.task_id === cleanTaskId) return 3;
    if (n.task_id && ancestorIds.has(n.task_id)) return 2;
    if (!n.task_id) return 1;
    return 0;
  };

  notes.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const sa = scoreScope(a);
    const sb = scoreScope(b);
    if (sa !== sb) return sb - sa;
    return b.updated_at.localeCompare(a.updated_at);
  });

  return notes;
}

/**
 * Delete a single note by note_id.
 */
export function deleteNote(db, projectId, noteId) {
  return withTransaction(db, () => {
    const info = db
      .prepare('DELETE FROM ProjectNotes WHERE note_id = ? AND project_id = ?')
      .run(noteId, projectId);
    if (info.changes > 0) {
      db.prepare('UPDATE Projects SET updated_at = ? WHERE project_id = ?').run(nowIso(), projectId);
      return true;
    }
    return false;
  });
}
