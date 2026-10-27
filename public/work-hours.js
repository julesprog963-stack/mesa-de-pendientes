(function () {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const dateFormat = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

  function duration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((part) => String(part).padStart(2, '0')).join(':');
  }

  function track(entity) {
    return { ...entity, _hoursReceivedAt: performance.now() };
  }

  function elapsed(entity) {
    return entity.hours?.activeSessionId ? Math.max(0, performance.now() - (entity._hoursReceivedAt ?? performance.now())) : 0;
  }

  function moment(value) {
    return dateFormat.format(new Date(value));
  }

  function render(entity, historyOpen = false) {
    const hours = entity.hours;
    if (!hours) return '';
    const sessions = hours.sessions || [];
    const latest = sessions[sessions.length - 1];
    const active = Boolean(hours.activeSessionId);
    const extra = elapsed(entity);
    return `<div class="work-hours-summary">
      <div class="work-counters"><div><span>Total trabajado</span><strong data-work-total="${escape(entity.id)}" role="timer" aria-live="off">${duration(hours.totalMs + extra)}</strong></div>${latest ? `<div><span>${active ? 'Sesión en curso' : 'Última sesión'}</span><strong class="work-session-duration" data-work-session="${escape(entity.id)}" role="timer" aria-live="off">${duration(latest.durationMs + (active ? extra : 0))}</strong></div>` : ''}</div>
      <p class="work-session-state ${active ? 'is-running' : ''}">${active ? 'Contador en curso' : 'Sin contador en curso'}</p>
      ${latest ? `<p class="work-period"><strong>Inicio:</strong> <time datetime="${escape(latest.startedAt)}">${escape(moment(latest.startedAt))}</time>${latest.endedAt ? `<br><strong>Fin:</strong> <time datetime="${escape(latest.endedAt)}">${escape(moment(latest.endedAt))}</time>` : ''}</p>` : '<p class="work-period">Todavía no hay horas registradas.</p>'}
      ${sessions.length ? `<details class="work-history" data-work-history="${escape(entity.id)}" ${historyOpen ? 'open' : ''}><summary>Registro de horas (${sessions.length})</summary><ol>${[...sessions].reverse().map((session) => `<li class="work-entry"><div><span>Inicio</span><time datetime="${escape(session.startedAt)}">${escape(moment(session.startedAt))}</time></div><div><span>Fin</span>${session.endedAt ? `<time datetime="${escape(session.endedAt)}">${escape(moment(session.endedAt))}</time>` : '<strong class="work-entry-running">En curso</strong>'}</div><div><span>Duración</span><strong data-work-entry="${escape(session.id)}">${duration(session.durationMs + (!session.endedAt ? extra : 0))}</strong></div></li>`).join('')}</ol></details>` : ''}
    </div>`;
  }

  function tick(entities) {
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    document.querySelectorAll('[data-work-total]').forEach((node) => {
      const entity = byId.get(node.dataset.workTotal);
      if (entity?.hours) node.textContent = duration(entity.hours.totalMs + elapsed(entity));
    });
    document.querySelectorAll('[data-work-session]').forEach((node) => {
      const entity = byId.get(node.dataset.workSession);
      const latest = entity?.hours?.sessions?.at(-1);
      if (latest) node.textContent = duration(latest.durationMs + (!latest.endedAt ? elapsed(entity) : 0));
    });
    entities.forEach((entity) => {
      const active = entity.hours?.sessions?.find((session) => session.id === entity.hours.activeSessionId);
      if (!active) return;
      document.querySelectorAll('[data-work-entry]').forEach((node) => {
        if (node.dataset.workEntry === active.id) node.textContent = duration(active.durationMs + elapsed(entity));
      });
    });
  }

  window.MesaHours = { track, render, tick, duration };
})();
