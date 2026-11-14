import { buildView, duration, clipped, unionIntervals, layoutOverlaps, timesheetCSV } from '../src/intervals.mjs';
import { dateKey, addDays, rangeDays } from '../src/dates.mjs';
import { createCalendarClient } from './client.mjs';

const client = createCalendarClient();

const root = document.getElementById('app');
const icons = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2m4 0h2m-8 3h2"/>',
  arrow: '<path d="m14 7-5 5 5 5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9zM2 14l10 6 10-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>'
};
const icon = (name, extra = '') => `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.calendar}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (d, options) => new Intl.DateTimeFormat('es-ES', options).format(new Date(d));
const time = d => fmt(d, { hour: 'numeric', minute: '2-digit' });
const fixed2 = n => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hours = ms => (ms / 3_600_000).toLocaleString('es-ES', { maximumFractionDigits: 1 });
const shortDuration = ms => { if (!ms) return '0 min'; const minutes = Math.round(ms / 60_000); return minutes < 1 ? '<1 min' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`; };
const palette = ['#3975c6', '#8a5bb6', '#168377', '#c67c2f', '#bb5276', '#557d3a', '#5b62bd', '#ad634a'];
const hash = value => [...value].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) | 0, 0);
const worktreeKey = value => String(value.cwd || value.workspace || value.sessionKey || value.key || 'Sin asignar').replaceAll('\\', '/').replace(/\/+$/, '');
const worktreeName = value => value.workspace || value.cwd?.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || value.project || 'Sin asignar';
let savedColors = [];
try { savedColors = await client.loadColors(); } catch {}
const colorAssignments = new Map(Array.isArray(savedColors) ? savedColors.filter(item => Array.isArray(item) && typeof item[0] === 'string' && Number.isInteger(item[1]) && item[1] >= 0 && item[1] < 10000) : []);
let colorSaveTimer;
function color(value) {
  const key = worktreeKey(value);
  if (!colorAssignments.has(key)) {
    const used = new Set(colorAssignments.values());
    let n = Math.abs(hash(key)) % palette.length;
    for (let offset = 0; offset < palette.length && used.has(n); offset++) n = (n + 1) % palette.length;
    if (used.has(n)) { n = palette.length; while (used.has(n)) n++; }
    colorAssignments.set(key, n);
    clearTimeout(colorSaveTimer);
    colorSaveTimer = setTimeout(() => { void client.saveColors([...colorAssignments]).catch(() => {}); }, 100);
  }
  const n = colorAssignments.get(key);
  return palette[n] || `hsl(${((n - palette.length) * 137.508 + 205) % 360} 62% 46%)`;
}
function worktreesInView(view) {
  const groups = new Map();
  for (const session of view.sessions) {
    const key = worktreeKey(session);
    if (!groups.has(key)) groups.set(key, { key, cwd: session.cwd, workspace: worktreeName(session), project: session.project, sessions: [] });
    groups.get(key).sessions.push(session);
  }
  return [...groups.values()].map(group => ({ ...group, blocks: view.blocks.filter(b => worktreeKey(b) === group.key) }));
}
const state = { anchor: new Date(), span: 1, page: 'calendar', grouping: 'threads', gap: 30, project: '', worktree: '', agent: '', search: '',
  filtersOpen: false, subagents: false, allLocal: false, snapshot: null, drawer: null, sourcesOpen: false, loading: true, error: '', errorCount: 0 };
let renderPending, refreshInFlight = false;
function scheduleRender() { clearTimeout(renderPending); renderPending = setTimeout(render, 80); }
function currentDays() { return rangeDays(state.anchor, state.page === 'timesheet' ? 7 : state.span); }
function currentView() {
  const days = currentDays();
  return buildView((state.snapshot?.sessions || []).filter(s => !state.worktree || worktreeKey(s) === state.worktree), { start: days[0].start, end: days.at(-1).end, gap: state.gap,
    project: state.project, agent: state.agent, search: state.search, subagents: state.subagents });
}
function calendarDuration(blocks) {
  const groups = new Map();
  for (const b of blocks) { const key = b.sessionKey || b.key; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(b); }
  return [...groups.values()].reduce((sum, items) => sum + duration(items), 0);
}

function rangeLabel(days) {
  const first = days[0].start, last = days.at(-1).start;
  if (days.length === 1) return fmt(first, { month: 'long', day: 'numeric', year: 'numeric' });
  const sameMonth = new Date(first).getMonth() === new Date(last).getMonth() && new Date(first).getFullYear() === new Date(last).getFullYear();
  const year = new Date(last).getFullYear(), month = fmt(last, { month: 'short' });
  return `${sameMonth ? new Date(first).getDate() : fmt(first, { month: 'short', day: 'numeric' })} – ${sameMonth ? new Date(last).getDate() : fmt(last, { day: 'numeric' })} ${month} ${year}`;
}

async function fetchSnapshot() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const allLocal = state.allLocal;
  try {
    const snapshot = await client.snapshot(allLocal);
    if (allLocal !== state.allLocal) return;
    state.snapshot = snapshot; state.error = ''; state.loading = false;
    render();
  } catch (error) { state.error = error.message; state.loading = false; render(); }
  finally { refreshInFlight = false; if (allLocal !== state.allLocal) void fetchSnapshot(); }
}

function metric(name, value, detail) {
  return `<div class="metric" title="${esc(detail)}"><div class="metric-label">${esc(name)}</div><div class="metric-value">${esc(value)}</div></div>`;
}
function render() {
  const previous = document.querySelector('.calendar-scroll, .timesheet-scroll');
  const scroll = previous ? { top: previous.scrollTop, left: previous.scrollLeft } : null;
  const focused = document.activeElement?.id, selection = document.activeElement?.selectionStart;
  const days = currentDays(), view = currentView(), worktrees = worktreesInView(view), status = state.snapshot?.status;
  root.innerHTML = `<main class="main" aria-label="Calendario de actividad">
    <header class="toolbar"><div class="date-controls"><button class="icon-button" data-step="-1" aria-label="Periodo anterior">${icon('arrow')}</button><button class="today-button" data-action="today">Hoy</button><button class="icon-button next" data-step="1" aria-label="Periodo siguiente">${icon('arrow')}</button><h1>${esc(rangeLabel(days))}</h1></div>
      <div class="toolbar-options"><div class="segmented" aria-label="Agrupar calendario">${['threads', 'projects'].map(group => `<button data-group="${group}" class="${state.grouping === group ? 'active' : ''}" aria-pressed="${state.grouping === group}">${group === 'threads' ? 'Hilos' : 'Proyectos'}</button>`).join('')}</div>
      <div class="segmented" aria-label="Margen de unión">${[15, 30, 60, 120].map(n => `<button data-gap="${n}" title="Une la actividad del mismo hilo cuando el hueco es de ${n} minutos o menos" class="${state.gap === n ? 'active' : ''}" aria-pressed="${state.gap === n}">${n < 60 ? n + ' min' : n / 60 + ' h'}</button>`).join('')}</div>
      <div class="segmented" aria-label="Rango del calendario">${[[1, 'Día'], [3, '3 días'], [7, 'Semana']].map(([n, label]) => `<button data-span="${n}" class="${state.page === 'calendar' && state.span === n ? 'active' : ''}" aria-pressed="${state.page === 'calendar' && state.span === n}">${label}</button>`).join('')}<button data-page="timesheet" class="${state.page === 'timesheet' ? 'active' : ''}" aria-pressed="${state.page === 'timesheet'}">Hoja de horas</button></div>
      <button class="icon-button ${state.filtersOpen ? 'active' : ''}" data-action="filters" title="Buscar y filtrar" aria-label="Buscar y filtrar" aria-expanded="${state.filtersOpen}">${icon('search')}</button><button class="icon-button" data-action="export" title="Exportar CSV" aria-label="Exportar CSV">${icon('download')}</button><button class="icon-button" data-action="sources" title="Fuentes de datos" aria-label="Fuentes de datos">${icon('layers')}</button><button class="icon-button" data-action="refresh" title="Actualizar historial" aria-label="Actualizar historial">${icon('refresh')}</button></div></header>
    ${state.error ? `<div class="notice error" role="alert">${esc(state.error)} <button data-action="retry">Reintentar</button></div>` : ''}
    <section class="metrics" aria-label="Resumen de actividad">${metric('Hilos', view.metrics.sessions, 'Sesiones distintas del proveedor en este periodo')}${metric('En el calendario', shortDuration(view.metrics.calendarMs), `Unidas con un margen de ${state.gap} minutos y redondeadas a tramos de 15 minutos`)}${metric('Turnos del agente', shortDuration(view.metrics.activeMs), 'Tramos de turno registrados; los agentes en paralelo cuentan por separado. Pueden incluir esperas o pausas.')}${metric('Pico en paralelo', view.metrics.peak, 'Máximo de sesiones distintas con turnos registrados solapados')}</section>
    ${state.filtersOpen ? `<div class="filters"><label class="search-control">${icon('search')}<input id="search" type="search" placeholder="Busca un agente o una tarea…" value="${esc(state.search)}" aria-label="Buscar tareas"></label><select id="project-filter" aria-label="Filtrar por proyecto"><option value="">Todos los proyectos</option>${[...new Set((state.snapshot?.sessions || []).map(s => s.project))].sort().map(p => `<option ${state.project === p ? 'selected' : ''} value="${esc(p)}">${esc(p)}</option>`).join('')}</select><select id="agent-filter" aria-label="Filtrar por agente"><option value="">Todos los agentes</option><option ${state.agent === 'Codex' ? 'selected' : ''}>Codex</option><option ${state.agent === 'Claude' ? 'selected' : ''}>Claude</option></select><button class="text-button" data-action="clear-filters">Limpiar filtros</button></div>` : ''}
    <div class="worktree-legend" aria-label="Worktrees">${worktrees.map(w => `<button data-worktree="${esc(w.key)}" title="${esc(w.project + ' / ' + w.workspace + '\n' + (w.cwd || ''))}"><span class="color-dot" style="--project:${color(w)}"></span>${esc(w.workspace)} <span class="quiet">${shortDuration(calendarDuration(w.blocks))}</span></button>`).join('')}${state.project || state.worktree || state.search || state.agent ? '<button class="text-button" data-action="clear-filters">Limpiar filtros</button>' : ''}</div>
    <section id="view-content">${!view.sessions.length ? emptyState(status) : state.page === 'timesheet' ? timesheet(view, days) : calendar(view, days)}</section>
    <footer class="view-footer"><span>Historial local · ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}${status?.scanning ? ' · Indexando…' : ''}${status?.errors?.length ? ` · ${status.errors.length} aviso${status.errors.length === 1 ? '' : 's'} de importación` : ''}</span><span title="Los tramos de turno pueden incluir esperas y pausas. No son horas de trabajo personales.">${status?.naming?.available ? 'Nombres de agente de Orca' : 'Títulos de tarea registrados'} · Tiempo de agente</span><button class="text-button" data-action="recap" title="Copia los títulos de tarea y las últimas respuestas del periodo seleccionado">${icon('copy')}Copiar resumen de trabajo</button></footer>
    </main>${state.drawer ? detailDrawer(view) : ''}${state.sourcesOpen ? sourcesModal() : ''}`;
  const next = document.querySelector('.calendar-scroll, .timesheet-scroll');
  if (scroll && next) { next.scrollTop = scroll.top; next.scrollLeft = scroll.left; }
  if (focused && document.getElementById(focused)) {
    const input = document.getElementById(focused); input.focus({ preventScroll: true });
    if (typeof selection === 'number' && input.setSelectionRange) { try { input.setSelectionRange(selection, selection); } catch {} }
  }
}

function emptyState(status) {
  const scanning = state.loading || status?.scanning;
  return `<div class="empty-state">${icon(scanning ? 'refresh' : 'calendar')}<h3>${scanning ? 'Recopilando el historial de tus agentes…' : 'Sin actividad por aquí.'}</h3><p>${scanning ? 'Leyendo las marcas de tiempo de las sesiones locales. La primera importación puede tardar un poco.' : state.search || state.project || state.worktree || state.agent ? 'Ninguna actividad coincide con estos filtros. Prueba con otro proyecto u otra búsqueda.' : 'No hay turnos de agente en este periodo. Elige una semana reciente con actividad o revisa las fuentes de datos.'}</p>${!scanning && (state.snapshot?.sessions || []).length ? '<button class="button" data-action="latest">Ir a la última actividad</button>' : ''}${!scanning ? '<button class="text-button" data-action="sources">Revisar fuentes de datos</button>' : ''}</div>`;
}

function calendar(view, days) {
  let blocks = view.blocks;
  if (state.grouping === 'projects') blocks = view.projects.flatMap(p => p.blocks.map((b, i) => {
    const contributors = view.sessions.filter(s => s.project === p.name && s.turns.some(t => t.start < b.end && t.end > b.start));
    const worktrees = [...new Map(contributors.map(s => [worktreeKey(s), s])).values()];
    return { ...b, key: `project:${p.name}:${i}`, project: p.name, title: p.name, count: contributors.length,
      worktreeColors: worktrees.map(s => color(s)), worktreeCount: worktrees.length };
  }));
  const localHour = (at, day) => at >= day.end ? 24 : new Date(at).getHours() + new Date(at).getMinutes() / 60 + new Date(at).getSeconds() / 3600;
  const parts = days.map(day => blocks.filter(b => b.start < day.end && b.end > day.start).map(b => ({ ...b,
    start: Math.max(b.start, day.start), end: Math.min(b.end, day.end) })));
  const all = parts.flatMap((items, i) => items.map(b => ({ from: localHour(b.start, days[i]), to: localHour(b.end, days[i]) })));
  const firstHour = Math.max(0, Math.min(8, Math.floor(Math.min(...all.map(b => b.from))) - 1));
  const lastHour = Math.min(24, Math.max(18, Math.ceil(Math.max(...all.map(b => b.to))) + 1));
  const rowHeight = 52, height = (lastHour - firstHour) * rowHeight;
  return `<div class="calendar-scroll"><div class="calendar-grid" style="--days:${days.length};--grid-height:${height}px;--hour-height:${rowHeight}px"><div class="calendar-corner">${esc(fmt(days[0].start, { month: 'short' }).toUpperCase())}</div>${days.map((d, i) => `<button class="day-header ${d.label === dateKey(Date.now()) ? 'is-today' : ''} ${[0, 6].includes(new Date(d.start).getDay()) ? 'weekend' : ''}" data-day="${d.label}"><span>${fmt(d.start, { weekday: 'short' })}</span><strong>${new Date(d.start).getDate()}</strong><small>${hours(calendarDuration(clipped(view.blocks, d.start, d.end)))}h</small></button>`).join('')}
    <div class="time-axis" style="height:${height}px">${Array.from({ length: lastHour - firstHour }, (_, i) => `<span style="top:${i * rowHeight}px">${String(firstHour + i).padStart(2, '0')}:00</span>`).join('')}</div>${days.map((d, i) => `<div class="day-column ${[0, 6].includes(new Date(d.start).getDay()) ? 'weekend' : ''}">${layoutOverlaps(parts[i]).map(b => {
      const top = (localHour(b.start, d) - firstHour) * rowHeight, h = Math.max(20, (localHour(b.end, d) - localHour(b.start, d)) * rowHeight);
      return `<button class="work-block ${b.worktreeColors ? 'project-summary' : ''} ${h < 48 ? 'compact' : ''}" style="--project:${b.worktreeColors ? (b.worktreeColors.length === 1 ? b.worktreeColors[0] : 'var(--muted)') : color(b)};top:${top}px;height:${h - 2}px;left:calc(${b.column / b.columns * 100}% + 3px);width:calc(${(b.span || 1) * 100 / b.columns}% - 6px)" ${b.sessionKey ? `data-session="${esc(b.sessionKey)}"` : `data-project-detail="${esc(b.project)}"`} title="${esc(`${b.title}\n${time(b.start)} – ${time(b.end)}\n${b.workspace || b.project}`)}"><strong>${b.live ? '<span class="live-dot"></span>' : ''}${esc(b.title)}</strong><span class="block-time">${time(b.start)}–${time(b.end)}${b.count ? ` · ${b.count} hilo${b.count === 1 ? '' : 's'}` : ''}</span><span class="block-project">${esc(b.workspace || (b.worktreeCount ? `${b.worktreeCount} worktree${b.worktreeCount === 1 ? '' : 's'}` : b.project))}</span>${b.worktreeColors ? `<span class="worktree-color-band" aria-hidden="true">${b.worktreeColors.map(c => `<i style="background:${c}"></i>`).join('')}</span>` : ''}</button>`;
    }).join('')}${d.label === dateKey(Date.now()) && new Date().getHours() >= firstHour && new Date().getHours() < lastHour ? `<div class="now-line" style="top:${(new Date().getHours() + new Date().getMinutes() / 60 - firstHour) * rowHeight}px"><span></span></div>` : ''}</div>`).join('')}</div></div>`;
}

function timesheet(view, days) {
  const totals = days.map(d => view.sessions.reduce((n, s) => n + duration(clipped(s.turns, d.start, d.end)), 0));
  return `<div class="timesheet-scroll"><table class="timesheet"><caption class="sr-only">Horas de agente registradas por hilo y día</caption><thead><tr><th>PROYECTO / HILO</th>${days.map(d => `<th class="${d.label === dateKey(Date.now()) ? 'today-cell' : ''}">${fmt(d.start, { weekday: 'short' })}<small>${fmt(d.start, { month: 'short', day: 'numeric' })}</small></th>`).join('')}<th>TOTAL</th></tr></thead><tbody>${view.projects.map(p => `<tr class="project-table-row"><th colspan="${days.length + 2}">${esc(p.name)}<small>${p.sessions} hilo${p.sessions === 1 ? '' : 's'}</small></th></tr>${view.sessions.filter(s => s.project === p.name).map(s => `<tr><td><button class="thread-table-title" data-session="${esc(s.key)}"><span class="color-dot" style="--project:${color(s)}"></span>${esc(s.title)}</button><span class="agent-label">${esc(s.agent)} · ${esc(worktreeName(s))}${s.isSubagent ? ' · subagente' : ''}</span></td>${days.map(d => {
    const n = duration(clipped(s.turns, d.start, d.end)) / 3_600_000;
    return `<td class="numeric ${n ? '' : 'zero'}">${n ? fixed2(n) : '—'}</td>`;
  }).join('')}<td class="numeric total">${fixed2(duration(s.turns) / 3_600_000)}</td></tr>`).join('')}`).join('')}</tbody><tfoot><tr><th>Total de horas de agente</th>${totals.map(n => `<td class="numeric">${fixed2(n / 3_600_000)}</td>`).join('')}<td class="numeric">${fixed2(view.metrics.activeMs / 3_600_000)}</td></tr></tfoot></table></div><div class="timesheet-note">${icon('clock')}Tiempo de turno registrado en horas decimales. Los agentes en paralelo cuentan por separado. Puede incluir pausas dentro de un turno; los huecos entre turnos y el redondeo del calendario no cuentan.</div>`;
}

function detailDrawer(view) {
  if (state.drawer.project) {
    const name = state.drawer.project; const list = view.sessions.filter(s => s.project === name);
    return `<div class="overlay" data-action="close-drawer"></div><aside class="detail-drawer" role="dialog" aria-modal="true" aria-label="Detalles del proyecto" tabindex="-1"><button class="icon-button drawer-close" data-action="close-drawer" aria-label="Cerrar detalles">${icon('close')}</button><div class="eyebrow">ACTIVIDAD DEL PROYECTO</div><h2>${esc(name)}</h2><p class="quiet">${list.length} hilo${list.length === 1 ? '' : 's'} en este periodo</p>${list.map(s => `<button class="drawer-session" data-session="${esc(s.key)}"><strong><span class="color-dot" style="--project:${color(s)}"></span>${esc(s.title)}</strong><small>${esc(worktreeName(s))} · ${esc(s.agent)} · ${shortDuration(duration(s.turns))}</small></button>`).join('')}</aside>`;
  }
  const session = (state.snapshot?.sessions || []).find(s => s.key === state.drawer.session);
  if (!session) return '';
  const turns = unionIntervals(session.turns), selected = view.sessions.find(s => s.key === session.key);
  return `<div class="overlay" data-action="close-drawer"></div><aside class="detail-drawer" role="dialog" aria-modal="true" aria-label="Detalles del hilo" tabindex="-1"><button class="icon-button drawer-close" data-action="close-drawer" aria-label="Cerrar detalles">${icon('close')}</button><div class="eyebrow">DETALLES DEL HILO</div><div class="detail-project" style="--project:${color(session)}"><span class="color-dot"></span>${esc(worktreeName(session))}<span class="agent-pill">${esc(session.agent)}</span></div><h2>${esc(session.title)}</h2><div class="detail-metrics"><div><strong>${shortDuration(duration(selected?.turns || []))}</strong><span>En este periodo</span></div><div><strong>${turns.length}</strong><span>Turnos registrados</span></div></div>${session.titleSource === 'orca' && session.prompt ? `<h3>Petición original</h3><p class="original-request">${esc(session.prompt)}</p>` : ''}<h3>Última respuesta</h3><p class="response-text">${esc(session.summary || 'Todavía no hay una respuesta final.')}</p><h3>Sesión</h3><dl class="session-data"><dt>Agente</dt><dd>${esc(session.agent)}${session.model ? ` · ${esc(session.model)}` : ''}</dd><dt>Primera actividad</dt><dd>${fmt(turns[0].start, { dateStyle: 'medium', timeStyle: 'short' })}</dd><dt>Última actividad</dt><dd>${fmt(turns.at(-1).end, { dateStyle: 'medium', timeStyle: 'short' })}</dd><dt>Espacio de trabajo</dt><dd>${esc(session.workspace || session.project)}</dd><dt>Ruta</dt><dd class="path-text">${esc(session.cwd)}</dd><dt>Origen del nombre</dt><dd>${session.titleSource === 'orca' ? 'Nombre de agente de Orca' : 'Primera petición registrada'}</dd><dt>ID de sesión</dt><dd class="path-text">${esc(session.id)}</dd></dl><button class="button" data-copy-session="${esc(session.key)}">${icon('copy')}Copiar ID de sesión</button><h3>Turnos recientes</h3><div class="turn-list">${[...turns].reverse().slice(0, 30).map(t => `<div><span>${fmt(t.start, { month: 'short', day: 'numeric' })} · ${time(t.start)}–${time(t.end)}</span><strong>${shortDuration(t.end - t.start)}</strong></div>`).join('')}</div><p class="quiet detail-note">Leído de las transcripciones locales del proveedor. ${session.agent === 'Claude' ? 'El tiempo de turno de Claude se reconstruye a partir de los mensajes.' : 'Codex usa los límites de turno registrados cuando están disponibles.'}</p></aside>`;
}

function sourcesModal() {
  const status = state.snapshot?.status;
  return `<div class="overlay" data-action="close-sources"></div><section class="sources-modal" role="dialog" aria-modal="true" aria-label="Fuentes de datos" tabindex="-1"><button class="icon-button drawer-close" data-action="close-sources" aria-label="Cerrar fuentes de datos">${icon('close')}</button><h2>Fuentes de datos</h2><p class="modal-intro">El calendario lee marcas de tiempo, títulos de tarea y extractos cortos de respuestas de los registros locales de sesiones de Codex y Claude. Nunca modifica esos registros ni los envía a un servicio externo.</p><p class="naming-status">${status?.naming?.available ? `Los nombres coinciden con el perfil activo de Orca (${status.naming.namedSessions} sesión${status.naming.namedSessions === 1 ? '' : 'es'} con nombre).` : 'Los nombres de Orca no están disponibles. Se muestran los títulos de tarea de las transcripciones como alternativa.'}</p><div class="source-list">${status?.sources?.length ? status.sources.map(s => `<div class="source-item"><div>${icon(s.available ? 'check' : 'dot')}<strong>${esc(s.agent)}${s.managed ? ' · Gestionado por Orca' : ''}</strong><span>${s.available ? `${s.files} archivo${s.files === 1 ? '' : 's'}` : 'No encontrado'}</span></div><code>${esc(s.path)}</code></div>`).join('') : '<p class="quiet">Las fuentes de historial aparecen aquí tras el primer escaneo.</p>'}</div><label class="setting-row"><div><strong>Incluir sesiones fuera de Orca</strong><p>Muestra todas las sesiones encontradas en estas carpetas del proveedor.</p></div><input id="all-local" type="checkbox" ${state.allLocal ? 'checked' : ''}></label><label class="setting-row"><div><strong>Incluir subagentes</strong><p>Incluye sesiones hijas con su propia transcripción. Suman a las horas de agente y a la concurrencia.</p></div><input id="subagents" type="checkbox" ${state.subagents ? 'checked' : ''}></label><p class="coverage-note">Cobertura: sesiones JSONL locales de Codex y Claude. No se incluyen otros proveedores, hosts remotos, registros borrados ni chats nativos sin transcripción del proveedor. Son horas de agente, no una medida de tu asistencia personal.</p>${status?.errors?.length ? `<div class="import-warnings">${status.errors.slice(0, 5).map(e => `<p>${esc(e)}</p>`).join('')}</div>` : ''}<button class="button primary" data-action="refresh">${icon('refresh')}Actualizar historial</button></section>`;
}

function toast(message) {
  const node = document.getElementById('toast'); node.textContent = message; node.classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('visible'), 3000);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado al portapapeles'); }
  catch { toast('El portapapeles no está disponible. Selecciona y copia el texto a mano.'); }
}
async function exportCSV() {
  try {
    const result = await client.saveCSV(timesheetCSV(currentView().sessions, currentDays()), `orca-activity-${currentDays()[0].label}.csv`);
    if (result.status === 'saved') toast('Hoja de horas exportada');
  } catch (error) { toast(error.message); }
}
function openModal() {
  render(); const modal = document.querySelector('[role="dialog"]'); modal?.focus();
}
root.addEventListener('click', async event => {
  const button = event.target.closest('button, [data-action]'); if (!button || button.disabled) return;
  const d = button.dataset;
  if (d.page) { state.page = d.page; state.drawer = null; render(); }
  else if (d.step) { state.anchor = addDays(state.anchor, Number(d.step) * currentDays().length); render(); }
  else if (d.span) { state.span = Number(d.span); state.page = 'calendar'; render(); }
  else if (d.group) { state.grouping = d.group; state.page = 'calendar'; render(); }
  else if (d.gap) { state.gap = Number(d.gap); render(); }
  else if (d.day) { state.anchor = new Date(d.day + 'T12:00:00'); state.span = 1; render(); }
  else if (d.worktree) { state.worktree = state.worktree === d.worktree ? '' : d.worktree; render(); }
  else if (d.project) { state.project = state.project === d.project ? '' : d.project; render(); }
  else if (d.session) { state.drawer = { session: d.session }; openModal(); }
  else if (d.projectDetail) { state.drawer = { project: d.projectDetail }; openModal(); }
  else if (d.copySession) copy((state.snapshot?.sessions || []).find(s => s.key === d.copySession)?.id || '');
  else if (d.action === 'filters') { state.filtersOpen = !state.filtersOpen; render(); if (state.filtersOpen) document.getElementById('search')?.focus(); }
  else if (d.action === 'clear-filters') { state.project = ''; state.worktree = ''; state.agent = ''; state.search = ''; render(); }
  else if (d.action === 'recap') { const view = currentView(); copy(`Trabajo de agentes · ${rangeLabel(currentDays())}\n\n` + view.sessions.map(s => `- [${s.workspace || s.project}] ${s.title} (${s.agent}, ${shortDuration(duration(s.turns))})${s.summary ? `\n  Última respuesta: ${s.summary}` : ''}`).join('\n')); }
  else if (d.action === 'today') { state.anchor = new Date(); render(); }
  else if (d.action === 'latest') { state.anchor = new Date(Math.max(...(state.snapshot?.sessions || []).flatMap(s => s.turns.map(t => t.end)))); render(); }
  else if (d.action === 'sources') { state.sourcesOpen = true; openModal(); }
  else if (d.action === 'close-sources') { state.sourcesOpen = false; render(); }
  else if (d.action === 'close-drawer') { state.drawer = null; render(); }
  else if (d.action === 'export') exportCSV();
  else if (d.action === 'retry') fetchSnapshot();
  else if (d.action === 'refresh') {
    try { toast('Buscando actividad nueva…'); await client.refresh(); await fetchSnapshot();
    } catch (error) { toast(error.message); }
  }
});
root.addEventListener('input', event => { if (event.target.id === 'search') { state.search = event.target.value; scheduleRender(); } });
root.addEventListener('change', event => {
  const { id, value, checked } = event.target;
  if (id === 'project-filter') state.project = value;
  if (id === 'agent-filter') state.agent = value;
  if (id === 'gap') state.gap = Number(value);
  if (id === 'all-local') { state.allLocal = checked; fetchSnapshot(); return; }
  if (id === 'subagents') state.subagents = checked;
  render();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { state.drawer = null; state.sourcesOpen = false; render(); }
  const dialog = document.querySelector('[role="dialog"]');
  if (event.key === 'Tab' && dialog) {
    const focusable = [...dialog.querySelectorAll('button, input, select, a[href]')].filter(x => !x.disabled);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
render();
try { client.onChange(() => { if (!document.hidden && !state.drawer && !state.sourcesOpen) void fetchSnapshot(); }); } catch (error) { state.error = error.message; }
await fetchSnapshot();
setInterval(() => { if (!document.hidden && !state.drawer && !state.sourcesOpen && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) fetchSnapshot(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.drawer && !state.sourcesOpen && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) fetchSnapshot(); });
