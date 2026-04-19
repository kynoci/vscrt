(function () {
  const vscode = acquireVsCodeApi();
  const content = window.__vscrtHelpContent;

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'className') node.className = v;
        else if (k === 'onClick') node.addEventListener('click', v);
        else if (k === 'onKeyDown') node.addEventListener('keydown', v);
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null || c === false) continue;
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      }
    }
    return node;
  }

  function renderTroubleshoot() {
    const panel = document.getElementById('panel-troubleshoot');
    panel.innerHTML = '';
    panel.appendChild(el('p', null, 'Common symptoms and where to reach first. Every diagnostic step below maps to a command in the Command Palette.'));
    for (const entry of content.troubleshooting) {
      panel.appendChild(
        el('div', { className: 'decision-card' }, [
          el('h3', null, entry.symptom),
          el('ol', null, entry.diagnose.map((step) => el('li', { html: inlineCode(step) }))),
        ]),
      );
    }
  }

  function inlineCode(text) {
    return String(text).replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function renderCapabilities() {
    const panel = document.getElementById('panel-capabilities');
    panel.innerHTML = '';
    const table = el('table', { role: 'grid' });
    const thead = el('thead', null, el('tr', null, [
      el('th', null, 'Feature'),
      el('th', null, 'Supported'),
      el('th', null, 'Notes'),
    ]));
    const tbody = el('tbody');
    for (const cap of content.capabilities) {
      tbody.appendChild(
        el('tr', null, [
          el('td', null, cap.feature),
          el('td', { className: cap.supported ? 'cap-yes' : 'cap-no' }, cap.supported ? '✓ yes' : '— not yet'),
          el('td', null, cap.notes),
        ]),
      );
    }
    table.appendChild(thead);
    table.appendChild(tbody);
    panel.appendChild(table);
  }

  function renderCommands() {
    const panel = document.getElementById('panel-commands');
    panel.innerHTML = '';
    for (const [group, list] of Object.entries(content.commandsByGroup)) {
      panel.appendChild(el('h2', null, group));
      for (const cmd of list) {
        const row = el('div', { className: 'command-row' }, [
          el('div', null, [
            el('div', null, cmd.title.replace(/^vsCRT:\s*/, '')),
            el('div', { className: 'cmd-id' }, cmd.id),
          ]),
          el('button', {
            className: 'action',
            onClick: () => runCommand(cmd.id),
          }, 'Run'),
        ]);
        panel.appendChild(row);
      }
    }
    if (content.keybindings.length > 0) {
      panel.appendChild(el('h2', null, 'Keyboard shortcuts'));
      const list = el('ul');
      for (const kb of content.keybindings) {
        list.appendChild(
          el('li', null, [
            el('span', { className: 'kbd' }, kb.key),
            ' — ',
            kb.command,
          ]),
        );
      }
      panel.appendChild(list);
    }
  }

  function renderSettings() {
    const panel = document.getElementById('panel-settings');
    panel.innerHTML = '';
    for (const s of content.settings) {
      const row = el('div', { className: 'setting-row' }, [
        el('div', null, [
          el('div', null, [
            el('strong', null, s.id),
            s.defaultValue ? ` — default ${s.defaultValue}` : '',
          ]),
          el('div', { className: 'setting-id' }, s.description),
          s.enum ? el('div', { className: 'setting-id' }, 'values: ' + s.enum.join(' | ')) : null,
        ]),
        el('button', {
          className: 'action',
          onClick: () => openSetting(s.id),
        }, 'Open'),
      ]);
      panel.appendChild(row);
    }
  }

  function runCommand(id) {
    vscode.postMessage({ type: 'runCommand', id });
  }
  function openSetting(id) {
    vscode.postMessage({ type: 'openSetting', id });
  }

  // Tabs
  const panels = {
    troubleshoot: { el: document.getElementById('panel-troubleshoot'), render: renderTroubleshoot, rendered: false },
    capabilities: { el: document.getElementById('panel-capabilities'), render: renderCapabilities, rendered: false },
    commands: { el: document.getElementById('panel-commands'), render: renderCommands, rendered: false },
    settings: { el: document.getElementById('panel-settings'), render: renderSettings, rendered: false },
  };
  const tabs = document.querySelectorAll('#tabs button');
  function activate(name) {
    for (const btn of tabs) {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const [n, p] of Object.entries(panels)) {
      const on = n === name;
      p.el.hidden = !on;
      if (on && !p.rendered) { p.render(); p.rendered = true; }
    }
  }
  for (const btn of tabs) {
    btn.addEventListener('click', () => activate(btn.dataset.tab));
  }
  activate('troubleshoot');
})();
