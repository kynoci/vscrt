(function () {
  const vscode = acquireVsCodeApi();
  const $ = function (id) { return document.getElementById(id); };
  // Set by the inline bootstrap <script> before this file is loaded.
  const editFlags = window.__vscrtEditFlags;

  const nameEl = $('name');
  const endpointEl = $('endpoint');
  const iconEl = $('icon');
  const iconButtonEl = $('icon-button');
  const iconButtonIconEl = $('icon-button-icon');
  const iconButtonLabelEl = $('icon-button-label');
  const iconListboxEl = $('icon-listbox');
  const iconListboxWrapEl = $('icon-listbox-wrap');
  const iconSearchEl = $('icon-select-search');
  const iconEmptyEl = $('icon-select-empty');
  const iconPreviewEl = $('icon-preview');
  const customIconRowEl = $('custom-icon-row');
  const customIconUris = (editFlags && editFlags.customIconUris) || {};
  const jumpHostEl = $('jumpHost');
  const portForwardsEl = $('portForwards');
  const envEl = $('env');
  const passwordEl = $('password');
  const identityFileEl = $('identityFile');
  const installEl = $('installPublicKeyNow');
  const otpEl = $('oneTimePassword');
  const otpSection = $('sect-otp');
  const sectPassword = $('sect-password');
  const sectPublicKey = $('sect-publickey');
  const submitBtn = $('submit');
  const cancelBtn = $('cancel');

  // Must match JUMP_HOST_PATTERN in src/treeView/serverFormModel.ts and
  // the `jumpHost.pattern` in schemas/vscrtConfig.schema.json.
  const JUMP_HOST_RE = /^[A-Za-z0-9._@:,[\]-]+$/;
  const PORT_FORWARD_RE = /^-[LRD] [0-9A-Za-z:.[\]/_-]+$/;
  const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function currentAuth() {
    const nodes = document.querySelectorAll('input[name="auth"]');
    for (let i = 0; i < nodes.length; i++) if (nodes[i].checked) return nodes[i].value;
    return 'password';
  }
  function currentStorage() {
    const nodes = document.querySelectorAll('input[name="storage"]');
    for (let i = 0; i < nodes.length; i++) if (nodes[i].checked) return nodes[i].value;
    return 'secretstorage';
  }
  function currentTermLoc() {
    const nodes = document.querySelectorAll('input[name="termloc"]');
    for (let i = 0; i < nodes.length; i++) if (nodes[i].checked) return nodes[i].value;
    return 'default';
  }

  function updateAuthVisibility() {
    const a = currentAuth();
    sectPassword.classList.toggle('hidden', a !== 'password');
    sectPublicKey.classList.toggle('hidden', a !== 'publickey');
    // Hide the password "*" required marker when editing a node that already
    // has a stored password and the user has kept Password auth selected.
    const req = $('password-req');
    if (req) {
      const canReuse = editFlags.isEdit &&
                       editFlags.hasExistingPassword &&
                       editFlags.originalAuth === 'password' &&
                       a === 'password';
      req.style.display = canReuse ? 'none' : '';
    }
  }
  function updateInstallVisibility() {
    otpSection.classList.toggle('hidden', !installEl.checked);
  }

  const authRadios = document.querySelectorAll('input[name="auth"]');
  for (let i = 0; i < authRadios.length; i++) {
    authRadios[i].addEventListener('change', updateAuthVisibility);
  }
  installEl.addEventListener('change', updateInstallVisibility);

  // --- Icon dropdown + preview ------------------------------------------

  function iconMarkupFor(name) {
    if (!name) return '';
    if (customIconUris[name]) {
      return '<img src="' + customIconUris[name] + '" alt="" />';
    }
    if (/^[a-z0-9-]+$/i.test(name)) {
      return '<i class="codicon codicon-' + name + '"></i>';
    }
    return '';
  }

  function renderIconPreview(name) {
    iconPreviewEl.innerHTML = iconMarkupFor(name);
  }

  function setDropdownSelection(value) {
    const options = iconListboxEl.querySelectorAll('[role="option"]');
    let matched = null;
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      const isMatch = o.getAttribute('data-value') === value;
      if (isMatch) {matched = o;}
      o.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    }
    if (!matched) return;
    const cell = matched.querySelector('.icon-cell');
    iconButtonIconEl.innerHTML = cell ? cell.innerHTML : '';
    const idSpan = matched.querySelector('.option-id');
    iconButtonLabelEl.textContent = idSpan
      ? idSpan.textContent
      : (matched.getAttribute('data-value') || '(default)');
    iconButtonLabelEl.classList.toggle('muted', !value || value === '__custom__');
  }

  function selectIconValue(value, opts) {
    setDropdownSelection(value);
    if (value === '__custom__') {
      customIconRowEl.classList.remove('hidden');
      renderIconPreview(iconEl.value.trim());
      if (opts && opts.focusInput) iconEl.focus();
    } else {
      customIconRowEl.classList.add('hidden');
      iconEl.value = value;
      renderIconPreview(value);
    }
    setError('icon', '');
  }

  function visibleOptions() {
    return Array.prototype.slice.call(
      iconListboxEl.querySelectorAll('[role="option"]:not(.hidden)'),
    );
  }

  function applyFilter() {
    const q = (iconSearchEl.value || '').trim().toLowerCase();
    const options = iconListboxEl.querySelectorAll('[role="option"]');
    let anyVisible = false;
    for (let i = 0; i < options.length; i++) {
      const item = options[i];
      const haystack = (item.getAttribute('data-search') || '').toLowerCase();
      const match = !q || haystack.indexOf(q) !== -1;
      item.classList.toggle('hidden', !match);
      if (match) anyVisible = true;
    }
    const groups = iconListboxEl.querySelectorAll('.icon-select-group');
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      let show = false;
      for (
        let el = g.nextElementSibling;
        el && !el.classList.contains('icon-select-group');
        el = el.nextElementSibling
      ) {
        if (el.getAttribute('role') === 'option' && !el.classList.contains('hidden')) {
          show = true;
          break;
        }
      }
      g.classList.toggle('hidden', !show);
    }
    iconEmptyEl.classList.toggle('hidden', anyVisible);
  }

  function openDropdown(focusSearch) {
    iconListboxWrapEl.classList.remove('hidden');
    iconButtonEl.setAttribute('aria-expanded', 'true');
    iconSearchEl.value = '';
    applyFilter();
    if (focusSearch) {
      iconSearchEl.focus();
    } else {
      const sel = iconListboxEl.querySelector('[aria-selected="true"]:not(.hidden)')
               || visibleOptions()[0];
      if (sel) sel.focus();
    }
  }
  function closeDropdown(focusButton) {
    iconListboxWrapEl.classList.add('hidden');
    iconButtonEl.setAttribute('aria-expanded', 'false');
    if (focusButton) iconButtonEl.focus();
  }
  function isDropdownOpen() {
    return iconButtonEl.getAttribute('aria-expanded') === 'true';
  }

  iconButtonEl.addEventListener('click', function (e) {
    e.stopPropagation();
    if (isDropdownOpen()) closeDropdown(); else openDropdown(true);
  });
  iconButtonEl.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDropdown(true);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openDropdown(false);
    }
  });

  // Keep mousedown from stealing focus *away* from the listbox options
  // (we still want focus to land on them). We do NOT preventDefault here so
  // that scrollbar drags and text selection inside the list keep working.
  iconListboxEl.addEventListener('click', function (e) {
    const li = e.target.closest('[role="option"]');
    if (!li) return;
    e.stopPropagation();
    selectIconValue(li.getAttribute('data-value'), { focusInput: true });
    closeDropdown(true);
  });

  function listKeydown(e) {
    const options = visibleOptions();
    const idx = options.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      if (idx < 0) {
        if (options[0]) options[0].focus();
      } else {
        (options[idx + 1] || options[options.length - 1]).focus();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (idx <= 0) {
        iconSearchEl.focus();
      } else {
        options[idx - 1].focus();
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      if (options[0]) options[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      if (options[options.length - 1]) options[options.length - 1].focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const cur = document.activeElement;
      if (cur && cur.hasAttribute('data-value')) {
        selectIconValue(cur.getAttribute('data-value'), { focusInput: true });
        closeDropdown(true);
      }
    } else if (e.key === 'Escape') {
      // stopPropagation so the page-level Escape handler doesn't also cancel
      // the whole form.
      e.preventDefault();
      e.stopPropagation();
      closeDropdown(true);
    } else if (e.key === 'Tab') {
      closeDropdown(false);
    }
  }
  iconListboxEl.addEventListener('keydown', listKeydown);

  iconSearchEl.addEventListener('input', applyFilter);
  iconSearchEl.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const first = visibleOptions()[0];
      if (first) first.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const first = visibleOptions()[0];
      if (first && first.hasAttribute('data-value')) {
        selectIconValue(first.getAttribute('data-value'), { focusInput: true });
        closeDropdown(true);
      }
    } else if (e.key === 'Escape') {
      // stopPropagation so the page-level Escape handler doesn't also cancel
      // the whole form.
      e.preventDefault();
      e.stopPropagation();
      closeDropdown(true);
    }
  });

  // Click-outside closes the dropdown.
  document.addEventListener('click', function (e) {
    if (!isDropdownOpen()) return;
    if (iconListboxWrapEl.contains(e.target) || iconButtonEl.contains(e.target)) return;
    closeDropdown();
  });

  iconEl.addEventListener('input', function () {
    renderIconPreview(iconEl.value.trim());
  });

  // Initialise dropdown state based on the edit-mode flags from the host.
  (function initIcon() {
    const initial = iconEl.value.trim();
    if (!initial) {
      selectIconValue('');
    } else if (editFlags && editFlags.iconIsPreset) {
      selectIconValue(initial);
    } else {
      setDropdownSelection('__custom__');
      customIconRowEl.classList.remove('hidden');
      renderIconPreview(initial);
    }
  })();

  // Track invalid fields in submit order so focus lands on the first bad one.
  let firstInvalid = null;
  function setError(forId, msg) {
    const el = document.querySelector('.error[data-for="' + forId + '"]');
    if (el) el.textContent = msg || '';
    const input = $(forId);
    if (input) {
      if (msg) {
        input.setAttribute('aria-invalid', 'true');
        if (!firstInvalid) firstInvalid = input;
      } else {
        input.removeAttribute('aria-invalid');
      }
    }
  }

  function validate() {
    let ok = true;
    const name = nameEl.value.trim();
    const endpoint = endpointEl.value.trim();
    const icon = iconEl.value.trim();
    const auth = currentAuth();

    firstInvalid = null;
    setError('name', '');
    setError('endpoint', '');
    setError('icon', '');
    setError('jumpHost', '');
    setError('portForwards', '');
    setError('env', '');
    setError('password', '');
    setError('identityFile', '');
    setError('oneTimePassword', '');

    if (!name) { setError('name', 'Name is required.'); ok = false; }

    if (!endpoint) {
      setError('endpoint', 'Endpoint is required.');
      ok = false;
    } else {
      const at = endpoint.indexOf('@');
      if (at < 1 || at >= endpoint.length - 1) {
        setError('endpoint', 'Expected format: user@host or user@host:port');
        ok = false;
      } else {
        const portMatch = endpoint.match(/^(.*):(\d+)$/);
        if (portMatch) {
          const n = parseInt(portMatch[2], 10);
          if (!isFinite(n) || n < 1 || n > 65535) {
            setError('endpoint', 'Port in user@host:port must be 1-65535.');
            ok = false;
          }
        }
      }
    }

    if (icon && !/^[a-z0-9-]+$/i.test(icon)) {
      setError('icon', 'Use only letters, digits, and hyphens.');
      ok = false;
    }

    const jumpHost = jumpHostEl.value.trim();
    if (jumpHost && !JUMP_HOST_RE.test(jumpHost)) {
      setError(
        'jumpHost',
        'Use letters, digits, . _ @ : , [ ] - only. For more exotic values, use extraArgs.',
      );
      ok = false;
    }

    const pfLines = portForwardsEl.value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pf of pfLines) {
      if (!PORT_FORWARD_RE.test(pf)) {
        setError(
          'portForwards',
          'Each line must be -L|-R|-D <spec>. Example: -L 3306:db:3306',
        );
        ok = false;
        break;
      }
    }

    const envLines = envEl.value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of envLines) {
      const eq = line.indexOf('=');
      if (eq <= 0) {
        setError('env', 'Each line must be KEY=value.');
        ok = false;
        break;
      }
      const k = line.slice(0, eq);
      if (!ENV_KEY_RE.test(k)) {
        setError(
          'env',
          'Env var names must match [A-Za-z_][A-Za-z0-9_]* — bad key: ' + k,
        );
        ok = false;
        break;
      }
    }

    if (auth === 'password') {
      const canReuse = editFlags.isEdit &&
                       editFlags.hasExistingPassword &&
                       editFlags.originalAuth === 'password';
      if (!passwordEl.value && !canReuse) {
        setError('password', 'Password is required.');
        ok = false;
      }
    } else {
      const idf = identityFileEl.value.trim();
      if (!idf) {
        setError('identityFile', 'Private key path is required.');
        ok = false;
      } else if (idf.endsWith('.pub')) {
        setError('identityFile', 'Enter the PRIVATE key file (not .pub).');
        ok = false;
      }
      if (installEl.checked && !otpEl.value) {
        setError('oneTimePassword', 'Required to install the public key.');
        ok = false;
      }
    }

    return ok;
  }

  function collectData() {
    const auth = currentAuth();
    const icon = iconEl.value.trim();
    const data = {
      name: nameEl.value.trim(),
      endpoint: endpointEl.value.trim(),
      preferredAuthentication: auth,
    };
    if (icon) data.icon = icon;
    const tl = currentTermLoc();
    if (tl === 'panel' || tl === 'editor') data.terminalLocation = tl;
    const jumpHost = jumpHostEl.value.trim();
    if (jumpHost) data.jumpHost = jumpHost;

    const portForwards = portForwardsEl.value
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (portForwards.length > 0) data.portForwards = portForwards;

    const env = {};
    let hasEnv = false;
    for (const line of envEl.value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
      hasEnv = true;
    }
    if (hasEnv) data.env = env;

    if (auth === 'password') {
      if (passwordEl.value) {
        // User typed a new password — replace the stored one.
        data.password = passwordEl.value;
      }
      // When editing and the field was left blank, we intentionally omit
      // 'password' so the handler preserves the existing stored reference.
      data.passwordStorage = currentStorage();
    } else {
      data.identityFile = identityFileEl.value.trim();
      if (installEl.checked) {
        data.installPublicKeyNow = true;
        data.oneTimePassword = otpEl.value;
      }
    }
    return data;
  }

  submitBtn.addEventListener('click', function () {
    if (!validate()) {
      if (firstInvalid) firstInvalid.focus();
      return;
    }
    vscode.postMessage({ type: 'submit', data: collectData() });
  });
  cancelBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'cancel' });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      if (validate()) {
        vscode.postMessage({ type: 'submit', data: collectData() });
      } else if (firstInvalid) {
        firstInvalid.focus();
      }
    }
  });

  updateAuthVisibility();
  updateInstallVisibility();
  nameEl.focus();
})();
