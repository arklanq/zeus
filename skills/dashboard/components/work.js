/* Reusable work views. All supplied content is rendered as text. */
window.DashboardComponents = window.DashboardComponents || {};
(function (C) {
  const labels = {todo:'Not started', doing:'In progress', done:'Done', blocked:'Blocked', unknown:'To confirm'};
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  C.element = el;
  C.status = function (status) { return el('span', labels[status] || labels.unknown, 'status status-' + (labels[status] ? status : 'unknown')); };
  C.milestone = function (milestone, tasks) {
    const section = el('section', null, 'milestone');
    const matched = tasks.filter(task => milestone.taskIds.includes(task.id));
    const done = matched.filter(task => task.status === 'done').length;
    const remaining = milestone.taskIds.length - done;
    section.append(el('h2', milestone.title + (milestone.proposed ? ' · Proposed' : '')));
    section.append(el('p', milestone.taskIds.length ? `${remaining} ${remaining === 1 ? 'task' : 'tasks'} left · ${done} of ${milestone.taskIds.length} complete` : 'Tasks have not been assigned yet.', 'muted'));
    if (milestone.taskIds.length) { const meter = el('progress'); meter.max = milestone.taskIds.length; meter.value = done; meter.setAttribute('aria-label', 'Milestone completion'); section.append(meter); }
    return section;
  };
  C.taskList = function (tasks, changedIds = []) {
    const list = el('div', null, 'task-list');
    tasks.forEach(task => {
      const row = el('details', null, 'task' + (changedIds.includes(task.id) ? ' changed' : ''));
      row.dataset.key = 'task:' + task.id;
      const summary = el('summary');
      summary.append(C.status(task.status), el('span', task.title, 'task-title'));
      if (changedIds.includes(task.id)) summary.append(el('span', 'Updated', 'updated-mark'));
      row.append(summary);
      const body = el('div', null, 'task-body');
      if (task.blocker) body.append(el('p', 'Waiting on: ' + task.blocker, 'blocker'));
      if (task.evidence) body.append(el('p', 'Evidence: ' + task.evidence));
      if (!task.blocker && !task.evidence) body.append(el('p', 'No supporting details reported yet.', 'muted'));
      row.append(body); list.append(row);
    });
    return list;
  };
  C.decisions = function (decisions) {
    const section = el('section', null, 'decisions'); section.append(el('h2', 'Decisions'));
    decisions.forEach(decision => {
      const item = el('div', null, 'decision');
      item.append(el('h3', decision.title));
      if (decision.default) item.append(el('p', 'Proposed default: ' + decision.default));
      item.append(el('p', decision.blocking ? 'Waiting for your decision.' : 'Does not block the current work.', 'muted'));
      section.append(item);
    }); return section;
  };
  C.activity = function (events) {
    const section = el('section', null, 'activity'); section.append(el('h2', 'Recent activity'));
    const list = el('ol');
    events.slice(-8).reverse().forEach(event => { const item = el('li'); const time = el('time', event.at ? new Date(event.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : ''); if (event.at) time.dateTime = event.at; item.append(time, el('span', event.text)); list.append(item); });
    section.append(list); return section;
  };
})(window.DashboardComponents);
