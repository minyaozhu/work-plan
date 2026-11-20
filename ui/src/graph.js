/**
 * Left-to-right hierarchical + dependency layered SVG graph layout and renderer.
 * Pure computation (layoutGraph) is exported separately so unit tests can run in Node without a DOM.
 */

export const CARD_W = 166;
export const CARD_H = 44;
export const COL_GAP = 54;
export const ROW_GAP = 14;
export const PAD_X = 20;
export const PAD_Y = 20;

/**
 * Compute deterministic left-to-right coordinates and cubic bezier paths for tasks & edges.
 * Solid edges = contains (parent -> child)
 * Dashed edges = dependency (upstream -> downstream)
 */
export function layoutGraph(tasks, deps) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { width: 400, height: 200, nodes: [], containsEdges: [], depEdges: [] };
  }

  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const childrenMap = new Map();
  for (const t of tasks) {
    if (t.parent_id && byId.has(t.parent_id)) {
      if (!childrenMap.has(t.parent_id)) childrenMap.set(t.parent_id, []);
      childrenMap.get(t.parent_id).push(t);
    }
  }

  // Assign tree depth (root = 0)
  const treeDepth = new Map();
  const getDepth = (id) => {
    if (treeDepth.has(id)) return treeDepth.get(id);
    const p = byId.get(id)?.parent_id;
    const d = p && byId.has(p) ? getDepth(p) + 1 : 0;
    treeDepth.set(id, d);
    return d;
  };
  for (const t of tasks) getDepth(t.task_id);

  // Relax columns by longest upstream dependency path + parent depth
  const colMap = new Map();
  for (const t of tasks) {
    colMap.set(t.task_id, treeDepth.get(t.task_id));
  }

  const validDeps = (deps || []).filter((d) => byId.has(d.upstream_id) && byId.has(d.downstream_id));
  for (let pass = 0; pass < tasks.length; pass++) {
    let changed = false;
    for (const t of tasks) {
      if (t.parent_id && byId.has(t.parent_id)) {
        const minChildCol = colMap.get(t.parent_id) + 1;
        if (colMap.get(t.task_id) < minChildCol) {
          colMap.set(t.task_id, minChildCol);
          changed = true;
        }
      }
    }
    for (const d of validDeps) {
      const minDownCol = colMap.get(d.upstream_id) + 1;
      if (colMap.get(d.downstream_id) < minDownCol) {
        colMap.set(d.downstream_id, minDownCol);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Preorder DFS rank keeps subtree siblings clustered cleanly vertically
  const preorderIndex = new Map();
  let dfsCounter = 0;
  const roots = tasks
    .filter((t) => !t.parent_id || !byId.has(t.parent_id))
    .sort((a, b) => (a.sort_key || 0) - (b.sort_key || 0));

  const walkPreorder = (t) => {
    if (preorderIndex.has(t.task_id)) return;
    preorderIndex.set(t.task_id, dfsCounter++);
    const ch = (childrenMap.get(t.task_id) || []).sort((a, b) => (a.sort_key || 0) - (b.sort_key || 0));
    for (const c of ch) walkPreorder(c);
  };
  for (const r of roots) walkPreorder(r);

  // Group into columns
  const columns = new Map();
  let maxCol = 0;
  for (const t of tasks) {
    const col = colMap.get(t.task_id) || 0;
    maxCol = Math.max(maxCol, col);
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(t);
  }

  const rowIndex = new Map();
  let maxRows = 1;
  for (let col = 0; col <= maxCol; col++) {
    const list = columns.get(col) || [];
    list.sort((a, b) => {
      const score = (node) => {
        const sources = [];
        if (node.parent_id && rowIndex.has(node.parent_id)) sources.push(rowIndex.get(node.parent_id));
        for (const d of validDeps) {
          if (d.downstream_id === node.task_id && rowIndex.has(d.upstream_id)) {
            sources.push(rowIndex.get(d.upstream_id));
          }
        }
        if (sources.length > 0) {
          return sources.reduce((s, v) => s + v, 0) / sources.length;
        }
        return preorderIndex.get(node.task_id) ?? 0;
      };
      const diff = score(a) - score(b);
      if (Math.abs(diff) > 0.01) return diff;
      return (preorderIndex.get(a.task_id) ?? 0) - (preorderIndex.get(b.task_id) ?? 0);
    });
    list.forEach((t, idx) => rowIndex.set(t.task_id, idx));
    maxRows = Math.max(maxRows, list.length);
  }

  const totalHeight = PAD_Y * 2 + maxRows * CARD_H + Math.max(0, maxRows - 1) * ROW_GAP;
  const totalWidth = PAD_X * 2 + (maxCol + 1) * CARD_W + maxCol * COL_GAP;

  const nodeMap = new Map();
  const nodes = [];
  for (let col = 0; col <= maxCol; col++) {
    const list = columns.get(col) || [];
    const colHeight = list.length * CARD_H + Math.max(0, list.length - 1) * ROW_GAP;
    const startY = PAD_Y + Math.max(0, (totalHeight - PAD_Y * 2 - colHeight) / 2);
    list.forEach((t, idx) => {
      const x = PAD_X + col * (CARD_W + COL_GAP);
      const y = startY + idx * (CARD_H + ROW_GAP);
      const node = {
        task: t,
        task_id: t.task_id,
        x,
        y,
        w: CARD_W,
        h: CARD_H,
        col,
        row: idx,
      };
      nodeMap.set(t.task_id, node);
      nodes.push(node);
    });
  }

  const makePath = (fromNode, toNode, yOffset = 0) => {
    const x1 = fromNode.x + fromNode.w;
    const y1 = fromNode.y + fromNode.h / 2 + yOffset;
    const x2 = toNode.x;
    const y2 = toNode.y + toNode.h / 2 + yOffset;
    const dx = Math.max(24, Math.abs(x2 - x1) * 0.48);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  const containsEdges = [];
  for (const t of tasks) {
    if (t.parent_id && nodeMap.has(t.parent_id) && nodeMap.has(t.task_id)) {
      containsEdges.push({
        from: t.parent_id,
        to: t.task_id,
        kind: 'contains',
        d: makePath(nodeMap.get(t.parent_id), nodeMap.get(t.task_id), -3),
      });
    }
  }

  const depEdges = [];
  for (const dep of validDeps) {
    if (nodeMap.has(dep.upstream_id) && nodeMap.has(dep.downstream_id)) {
      depEdges.push({
        from: dep.upstream_id,
        to: dep.downstream_id,
        kind: 'dependency',
        d: makePath(nodeMap.get(dep.upstream_id), nodeMap.get(dep.downstream_id), 3),
      });
    }
  }

  return {
    width: Math.max(420, totalWidth),
    height: Math.max(220, totalHeight),
    nodes,
    containsEdges,
    depEdges,
  };
}

function truncateText(text, maxChars = 24) {
  const s = String(text || '');
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

/**
 * Format task title and brief for the dependency graph node tooltip.
 */
export function formatNodeTooltip(task) {
  return {
    title: String(task?.title || task?.task_id || ''),
    brief: String(task?.brief || '').trim(),
  };
}

/**
 * Render interactive SVG dependency graph inside a container element with zoom/pan/lineage highlight.
 */
export function mountDependencyGraph(
  container,
  { tasks, deps, selectedTaskId, onSelectTask }
) {
  const layout = layoutGraph(tasks, deps);
  const svgNS = 'http://www.w3.org/2000/svg';

  container.innerHTML = '';

  const stage = document.createElement('div');
  stage.className = 'graph-stage';

  const tooltip = document.createElement('div');
  tooltip.className = 'graph-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;

  const tooltipTitle = document.createElement('div');
  tooltipTitle.className = 'graph-tooltip-title';
  const tooltipBrief = document.createElement('div');
  tooltipBrief.className = 'graph-tooltip-brief';
  tooltip.appendChild(tooltipTitle);
  tooltip.appendChild(tooltipBrief);

  const positionTooltip = (clientX, clientY) => {
    if (tooltip.hidden) return;
    const stageRect = stage.getBoundingClientRect();
    const pad = 8;
    const offset = 12;
    const tipW = tooltip.offsetWidth || 200;
    const tipH = tooltip.offsetHeight || 54;
    let left = clientX - stageRect.left + offset;
    let top = clientY - stageRect.top + offset;
    if (left + tipW + pad > stage.clientWidth) {
      left = Math.max(pad, clientX - stageRect.left - tipW - offset);
    }
    if (top + tipH + pad > stage.clientHeight) {
      top = Math.max(pad, stage.clientHeight - tipH - pad);
    }
    left = Math.max(pad, Math.min(left, Math.max(pad, stage.clientWidth - tipW - pad)));
    top = Math.max(pad, Math.min(top, Math.max(pad, stage.clientHeight - tipH - pad)));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const showTooltip = (task, clientX, clientY) => {
    const info = formatNodeTooltip(task);
    tooltipTitle.textContent = info.title;
    tooltipBrief.textContent = info.brief || 'No brief provided.';
    tooltipBrief.classList.toggle('muted', !info.brief);
    tooltip.hidden = false;
    positionTooltip(clientX, clientY);
  };

  const hideTooltip = () => {
    tooltip.hidden = true;
  };

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'graph-svg');
  svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const defs = document.createElementNS(svgNS, 'defs');
  defs.innerHTML = `
    <marker id="wp-arrow-contains" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 1 2 L 8 5 L 1 8 z" class="edge-arrow-contains"/>
    </marker>
    <marker id="wp-arrow-dep" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 1 2 L 8 5 L 1 8 z" class="edge-arrow-dep"/>
    </marker>
  `;
  svg.appendChild(defs);

  const viewportGroup = document.createElementNS(svgNS, 'g');
  viewportGroup.setAttribute('class', 'graph-viewport');
  svg.appendChild(viewportGroup);

  const edgesGroup = document.createElementNS(svgNS, 'g');
  const nodesGroup = document.createElementNS(svgNS, 'g');
  viewportGroup.appendChild(edgesGroup);
  viewportGroup.appendChild(nodesGroup);

  const edgeEls = [];
  for (const edge of layout.containsEdges) {
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', edge.d);
    p.setAttribute('class', 'graph-edge graph-edge--contains');
    p.setAttribute('marker-end', 'url(#wp-arrow-contains)');
    p.dataset.from = edge.from;
    p.dataset.to = edge.to;
    edgesGroup.appendChild(p);
    edgeEls.push(p);
  }

  for (const edge of layout.depEdges) {
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', edge.d);
    p.setAttribute('class', 'graph-edge graph-edge--dep');
    p.setAttribute('marker-end', 'url(#wp-arrow-dep)');
    p.dataset.from = edge.from;
    p.dataset.to = edge.to;
    edgesGroup.appendChild(p);
    edgeEls.push(p);
  }

  // Build adjacency for hover lineage highlighting
  const upstreamMap = new Map();
  const downstreamMap = new Map();
  for (const d of deps || []) {
    if (!upstreamMap.has(d.downstream_id)) upstreamMap.set(d.downstream_id, []);
    upstreamMap.get(d.downstream_id).push(d.upstream_id);
    if (!downstreamMap.has(d.upstream_id)) downstreamMap.set(d.upstream_id, []);
    downstreamMap.get(d.upstream_id).push(d.downstream_id);
  }

  const collectLineage = (rootId) => {
    const related = new Set([rootId]);
    const walkUp = (id) => {
      for (const u of upstreamMap.get(id) || []) {
        if (!related.has(u)) {
          related.add(u);
          walkUp(u);
        }
      }
    };
    const walkDown = (id) => {
      for (const d of downstreamMap.get(id) || []) {
        if (!related.has(d)) {
          related.add(d);
          walkDown(d);
        }
      }
    };
    walkUp(rootId);
    walkDown(rootId);
    return related;
  };

  const nodeEls = new Map();
  for (const node of layout.nodes) {
    const t = node.task;
    const g = document.createElementNS(svgNS, 'g');
    const statusSlug = t.status.toLowerCase();
    const isSel = t.task_id === selectedTaskId;
    g.setAttribute(
      'class',
      `graph-node graph-node--${statusSlug}${t.is_ready ? ' graph-node--ready' : ''}${isSel ? ' graph-node--selected' : ''}`
    );
    g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${t.title} (${t.status})`);

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('width', node.w);
    rect.setAttribute('height', node.h);
    rect.setAttribute('rx', '6');
    rect.setAttribute('class', 'graph-card');
    g.appendChild(rect);

    const titleText = document.createElementNS(svgNS, 'text');
    titleText.setAttribute('x', '9');
    titleText.setAttribute('y', '17');
    titleText.setAttribute('class', 'graph-card-title');
    titleText.textContent = truncateText(t.title, 22);
    g.appendChild(titleText);

    const subText = document.createElementNS(svgNS, 'text');
    subText.setAttribute('x', '9');
    subText.setAttribute('y', '33');
    subText.setAttribute('class', 'graph-card-meta');
    const badge = t.is_ready ? ' · READY' : t.is_waiting ? ' · WAITING' : '';
    const activeBadge = t.conv_id ? ' · ●' : '';
    subText.textContent = `${t.status}${badge}${activeBadge}`;
    g.appendChild(subText);

    const highlight = (focusId) => {
      if (!focusId) {
        for (const el of nodeEls.values()) el.classList.remove('dimmed', 'highlighted');
        for (const e of edgeEls) e.classList.remove('dimmed', 'highlighted');
        return;
      }
      const rel = collectLineage(focusId);
      for (const [id, el] of nodeEls.entries()) {
        el.classList.toggle('highlighted', rel.has(id));
        el.classList.toggle('dimmed', !rel.has(id));
      }
      for (const e of edgeEls) {
        const hit = rel.has(e.dataset.from) && rel.has(e.dataset.to);
        e.classList.toggle('highlighted', hit);
        e.classList.toggle('dimmed', !hit);
      }
    };

    g.addEventListener('pointerenter', (e) => {
      highlight(t.task_id);
      showTooltip(t, e.clientX, e.clientY);
    });
    g.addEventListener('pointermove', (e) => {
      positionTooltip(e.clientX, e.clientY);
    });
    g.addEventListener('pointerleave', () => {
      highlight(null);
      hideTooltip();
    });
    g.addEventListener('focus', () => {
      highlight(t.task_id);
      const r = g.getBoundingClientRect();
      showTooltip(t, r.right, r.top);
    });
    g.addEventListener('blur', () => {
      highlight(null);
      hideTooltip();
    });
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTooltip();
      onSelectTask?.(t.task_id);
    });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectTask?.(t.task_id);
      }
    });

    nodesGroup.appendChild(g);
    nodeEls.set(t.task_id, g);
  }

  // Pan & zoom controls
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const applyTransform = () => {
    viewportGroup.setAttribute('transform', `translate(${tx}, ${ty}) scale(${scale})`);
  };

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let baseTx = 0;
  let baseTy = 0;

  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.graph-node')) return;
    hideTooltip();
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    baseTx = tx;
    baseTy = ty;
    svg.setPointerCapture(e.pointerId);
  });

  svg.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const ratioX = layout.width / Math.max(1, rect.width);
    const ratioY = layout.height / Math.max(1, rect.height);
    tx = baseTx + (e.clientX - dragStartX) * ratioX;
    ty = baseTy + (e.clientY - dragStartY) * ratioY;
    applyTransform();
  });

  const endDrag = () => {
    dragging = false;
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      scale = Math.max(0.35, Math.min(2.8, scale * factor));
      applyTransform();
    },
    { passive: false }
  );

  stage.appendChild(svg);
  stage.appendChild(tooltip);
  container.appendChild(stage);

  return {
    layout,
    zoomIn() {
      scale = Math.min(2.8, scale * 1.2);
      applyTransform();
    },
    zoomOut() {
      scale = Math.max(0.35, scale / 1.2);
      applyTransform();
    },
    fit() {
      scale = 1;
      tx = 0;
      ty = 0;
      applyTransform();
    },
  };
}
