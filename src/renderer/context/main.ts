import { t, setLocale, getLocale, type DictKey } from '../../shared/i18n';
import { CONTEXT_LAYOUT, CONTEXT_WINDOW_SIZE, emptyContext, freshness, sortContextNotes, type ContextCommand, type ContextData } from '../../shared/context';
import './style.css';
import { bindContextDrag } from './drag';

const api = window.contextAPI;
const root = document.querySelector<HTMLElement>('#app')!;
const captureMode = new URLSearchParams(location.search).get('mode') === 'capture';
for (const [key, value] of Object.entries({
  'window-width': CONTEXT_WINDOW_SIZE.width, 'window-height': CONTEXT_WINDOW_SIZE.height,
  'panel-left': CONTEXT_LAYOUT.panel.x, 'panel-top': CONTEXT_LAYOUT.panel.y,
  'panel-width': CONTEXT_LAYOUT.panel.width, 'panel-height': CONTEXT_LAYOUT.panel.height,
  'switch-width': CONTEXT_LAYOUT.switchInset.width, 'switch-height': CONTEXT_LAYOUT.switchInset.height,
})) root.style.setProperty(`--${key}`, `${value}px`);
root.style.setProperty('--panel-columns', CONTEXT_LAYOUT.columns.map((width) => `${width}px`).join(' '));
const icons = {
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  copy: '<rect x="4" y="6" width="10" height="12"/><path d="M8 6V2h10v12h-4M7 10h4M7 13h4"/>',
  trash: '<path d="M3 5h14M7 2h6M5 5v13h10V5M8 8v7M12 8v7"/>',
  plus: '<path d="M10 2v16M2 10h16"/>',
  archive: '<path d="M3 7h14v11H3zM2 3h16v4H2zM7 11h6"/>',
  mouse: '<path d="M5 2v15l4-4 3 5 3-2-3-5h6z"/>',
  restore: '<path d="M3 9a7 7 0 1 1 1 7M3 3v6h6"/>',
};
function button(id: string, label: string, icon: keyof typeof icons): string {
  return `<button id="${id}" type="button" title="${label}" aria-label="${label}"><svg viewBox="0 0 20 20" aria-hidden="true">${icons[icon]}</svg></button>`;
}

let data = emptyContext();
let selected: string | null = null;
let archived = false;
const pendingText = new Map<string, string>();
let pendingScratch: string | null = null;

let statusKey: DictKey | null = null;
let refreshContent = (): void => {};
function status(key: DictKey | null): void {
  statusKey = key;
  const message = key ? t(key) : captureMode ? t('context.captureHint') : '';
  const element = document.querySelector<HTMLElement>('#status')!;
  element.textContent = message;
  element.title = message;
}

async function change(command: ContextCommand): Promise<ContextData | null> {
  try {
    const next = await api.change(command);
    status(null);
    return next;
  } catch (error) {
    console.error('[context] Save failed:', error);
    status('context.saveError');
    return null;
  }
}

if (captureMode) {
  root.innerHTML = `<section class="capture"><div id="capture-drag" title="${t('context.captureDrag')}" aria-label="${t('context.captureDragLabel')}"><span></span></div>${button('capture-close', t('context.captureClose'), 'close')}<textarea id="capture-text" maxlength="100000" aria-label="${t('context.captureTitle')}" placeholder="${t('context.capturePlaceholder')}" autofocus></textarea><footer><span id="status" role="status">${t('context.captureHint')}</span><button id="capture-save">${t('context.save')}</button></footer></section>`;
  bindContextDrag(document.getElementById('capture-drag')!, api);
  document.getElementById('capture-close')!.onclick = () => api.closeCapture();
  const input = document.querySelector<HTMLTextAreaElement>('#capture-text')!;
  const save = document.querySelector<HTMLButtonElement>('#capture-save')!;
  let saving = false;
  async function submit(): Promise<void> {
    if (saving || !input.value.trim()) return;
    saving = true;
    save.disabled = true;
    input.readOnly = true;
    const next = await change({ type: 'add', text: input.value });
    saving = false;
    save.disabled = false;
    input.readOnly = false;
    if (next) { input.value = ''; api.closeCapture(); }
  }
  save.onclick = () => { void submit(); };
  input.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); api.closeCapture(); }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
  };
  api.onCapture(() => { input.focus(); });
  input.focus();
} else {
  root.innerHTML = `<button id="tomato" aria-label="${t('context.pin')}" title="${t('context.pinHint')}"><img src="./context/minitomato2.png" draggable="false" alt="" /></button>
    <section id="panel" aria-label="${t('context.title')}">
      <div class="notes-column"><div id="notes" role="list" tabindex="0" aria-label="${t('context.list')}"></div><footer>${button('archive', t('context.archive'), 'archive')}${button('add', t('context.add'), 'plus')}</footer></div>
      <div class="editor-column"><textarea id="note-text" maxlength="100000" aria-label="${t('context.note')}" placeholder="${t('context.notePlaceholder')}"></textarea><footer><span id="status" role="status"></span>${button('restore', t('context.restore'), 'restore')}${button('copy-note', t('context.copyNote'), 'copy')}${button('delete-note', t('context.deleteNote'), 'trash')}</footer></div>
      <div class="scratch-column"><header>${button('passthrough', t('context.passthroughOff'), 'mouse')}<input id="opacity" type="range" min="20" max="100" value="100" aria-label="${t('context.opacity')}" title="${t('context.opacity')}" /></header><textarea id="scratch" maxlength="100000" aria-label="${t('context.scratch')}" placeholder=""></textarea><footer>${button('copy-scratch', t('context.copyScratch'), 'copy')}${button('delete-scratch', t('context.clearScratch'), 'trash')}</footer></div>
    </section>`;
  const panel = document.querySelector<HTMLElement>('#panel')!;
  const noteText = document.querySelector<HTMLTextAreaElement>('#note-text')!;
  const scratch = document.querySelector<HTMLTextAreaElement>('#scratch')!;
  const opacity = document.querySelector<HTMLInputElement>('#opacity')!;
  const notes = document.querySelector<HTMLElement>('#notes')!;
  for (const column of root.querySelectorAll<HTMLElement>('.notes-column, .editor-column')) {
    const handle = document.createElement('div');
    handle.className = 'notes-drag';
    column.prepend(handle);
    bindContextDrag(handle, api);
  }
  function updateListFade(): void {
    // 只在该方向仍有隐藏内容时淡出，首尾完整条目不会被无故淡化。
    notes.style.setProperty('--fade-top', notes.scrollTop > 1 ? '12px' : '0px');
    notes.style.setProperty('--fade-bottom', notes.scrollHeight - notes.clientHeight - notes.scrollTop > 1 ? '12px' : '0px');
  }
  notes.addEventListener('scroll', updateListFade, { passive: true });
  new ResizeObserver(updateListFade).observe(notes);
  function click(id: string, handler: () => void): void { document.getElementById(id)!.onclick = handler; }

  function render(): void {
    const visible = sortContextNotes(data.notes.filter((note) => (note.archivedAt !== null) === archived));
    if (!visible.some((note) => note.id === selected)) selected = visible[0]?.id ?? null;
    const scroll = notes.scrollTop;
    const focusedRow = document.activeElement?.closest<HTMLElement>('.note-row');
    const focusedId = focusedRow?.dataset.noteId;
    const focusedColor = document.activeElement?.classList.contains('freshness');
    notes.replaceChildren();
    for (const note of visible) {
      const row = document.createElement('div');
      row.className = `note-row${note.id === selected ? ' selected' : ''}`;
      row.setAttribute('role', 'listitem');
      row.dataset.noteId = note.id;
      const preserve = document.createElement('button');
      preserve.className = `freshness stage-${freshness(note)}`;
      preserve.title = note.preserved ? t('context.unpreserve') : t('context.preserve');
      preserve.setAttribute('aria-label', preserve.title);
      preserve.setAttribute('aria-pressed', String(note.preserved));
      preserve.onclick = () => { void change({ type: 'preserve', id: note.id }); };
      const label = document.createElement('button');
      label.className = 'note-label';
      label.textContent = (pendingText.get(note.id) ?? note.text).trim() || t('context.untitled');
      label.title = `${note.text}\n${note.archivedAt ? t('context.archived') : note.preserved ? t('context.preserved') : t('context.freshness', { min: freshness(note) * 30, max: (freshness(note) + 1) * 30 })}`;
      label.setAttribute('aria-current', String(note.id === selected));
      label.onclick = () => { selected = note.id; render(); };
      row.append(preserve, label);
      notes.append(row);
    }
    notes.scrollTop = scroll;
    if (focusedId) {
      const rows = Array.from(notes.querySelectorAll<HTMLElement>('.note-row'));
      const nextRow = rows.find((row) => row.dataset.noteId === focusedId)
        ?? rows.find((row) => row.dataset.noteId === selected);
      const target = nextRow?.querySelector<HTMLElement>(focusedColor ? '.freshness' : '.note-label') ?? notes;
      target.focus({ preventScroll: true });
    }
    const note = data.notes.find((item) => item.id === selected);
    const text = note ? pendingText.get(note.id) ?? note.text : '';
    if (noteText.value !== text) noteText.value = text;
    noteText.disabled = !note;
    noteText.placeholder = archived ? t('context.emptyArchive') : t('context.notePlaceholder');
    const scratchValue = pendingScratch ?? data.scratch;
    if (scratch.value !== scratchValue) scratch.value = scratchValue;
    if (document.activeElement !== opacity) opacity.value = String(Math.round(data.opacity * 100));
    document.getElementById('restore')!.hidden = !archived || !note;
    for (const id of ['copy-note', 'delete-note']) (document.getElementById(id) as HTMLButtonElement).disabled = !note;
    document.getElementById('archive')!.setAttribute('aria-pressed', String(archived));
    document.getElementById('archive')!.title = archived ? t('context.back') : t('context.archive');
    document.getElementById('archive')!.setAttribute('aria-label', document.getElementById('archive')!.title);
    updateListFade();
  }
  refreshContent = render;
  api.onData((next) => { data = next; render(); });
  api.onState((state) => {
    root.classList.toggle('expanded', state.expanded);
    root.classList.toggle('passthrough', state.passthrough);
    panel.inert = !state.expanded;
    document.getElementById('tomato')!.setAttribute('aria-pressed', String(state.pinned));
    document.querySelector<HTMLImageElement>('#tomato img')!.src = state.pinned
      ? './context/minitomato2_lock.png' : './context/minitomato2.png';
    const passthrough = document.getElementById('passthrough')!;
    passthrough.setAttribute('aria-pressed', String(state.passthrough));
    passthrough.title = state.passthrough ? t('context.passthroughOn') : t('context.passthroughOff');
    passthrough.setAttribute('aria-label', passthrough.title);
  });
  bindContextDrag(document.getElementById('tomato')!, api);
  click('tomato', () => api.togglePin());
  click('passthrough', () => api.setPassthrough(!root.classList.contains('passthrough')));
  click('archive', () => { archived = !archived; selected = null; render(); });
  click('add', () => {
    void (async () => {
      const previous = new Set(data.notes.map((note) => note.id));
      const next = await change({ type: 'add', text: '' });
      if (!next) return;
      data = next;
      selected = next.notes.find((note) => !previous.has(note.id))?.id ?? null;
      archived = false;
      render();
      noteText.focus();
    })();
  });
  noteText.oninput = () => {
    if (!selected) return;
    const id = selected;
    const text = noteText.value;
    pendingText.set(id, text);
    void change({ type: 'edit', id, text }).then((next) => {
      if (next && pendingText.get(id) === text) { pendingText.delete(id); data = next; render(); }
    });
  };
  scratch.oninput = () => {
    const text = scratch.value;
    pendingScratch = text;
    void change({ type: 'scratch', text }).then((next) => {
      if (next && pendingScratch === text) { pendingScratch = null; data = next; render(); }
    });
  };
  opacity.oninput = () => { void change({ type: 'opacity', value: Number(opacity.value) / 100 }); };
  click('restore', () => { if (selected) void change({ type: 'restore', id: selected }); });
  let deleting = false;
  async function deleteNote(id: string | null): Promise<void> {
    if (!id || deleting) return;
    deleting = true;
    try { if (await change({ type: 'delete', id })) pendingText.delete(id); }
    finally { deleting = false; }
  }
  click('delete-note', () => { void deleteNote(selected); });
  notes.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    const row = (event.target as HTMLElement).closest<HTMLElement>('.note-row');
    void deleteNote(row?.dataset.noteId ?? selected);
  });
  click('delete-scratch', () => {
    scratch.value = '';
    scratch.dispatchEvent(new Event('input'));
  });
  async function copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); status('context.copied'); }
    catch { status('context.copyError'); }
  }
  click('copy-note', () => { void copy(noteText.value); });
  click('copy-scratch', () => { void copy(scratch.value); });
  void api.load().then((next) => { data = next; render(); }).catch(() => status('context.loadError')).finally(async () => {
    await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => undefined)));
    requestAnimationFrame(() => requestAnimationFrame(() => api.ready()));
  });
}

// 更新界面标签，不重建编辑器，保留草稿、焦点和选区。
function localize(): void {
  document.documentElement.lang = getLocale();
  document.title = t(captureMode ? 'context.captureTitle' : 'context.title');
  const labels: Record<string, DictKey> = captureMode ? {
    'capture-drag': 'context.captureDrag', 'capture-close': 'context.captureClose',
    'capture-text': 'context.captureTitle',
  } : {
    tomato: 'context.pinHint', panel: 'context.title', notes: 'context.list',
    add: 'context.add', 'note-text': 'context.note', restore: 'context.restore',
    'copy-note': 'context.copyNote', 'delete-note': 'context.deleteNote',
    passthrough: root.classList.contains('passthrough') ? 'context.passthroughOn' : 'context.passthroughOff',
    opacity: 'context.opacity', scratch: 'context.scratch',
    'copy-scratch': 'context.copyScratch', 'delete-scratch': 'context.clearScratch',
  };
  for (const [id, key] of Object.entries(labels)) {
    const element = document.getElementById(id)!;
    element.title = t(key);
    element.setAttribute('aria-label', t(key));
  }
  if (captureMode) {
    document.querySelector<HTMLTextAreaElement>('#capture-text')!.placeholder = t('context.capturePlaceholder');
    document.getElementById('capture-save')!.textContent = t('context.save');
  }
  refreshContent();
  status(statusKey);
}
let receivedSettings = false;
window.settingsAPI.onUpdated((settings) => {
  receivedSettings = true;
  setLocale(settings.language);
  localize();
});
void window.settingsAPI.load().then((settings) => {
  if (!receivedSettings) { setLocale(settings.language); localize(); }
}).catch((error) => console.error('[context] Settings load failed:', error)).finally(async () => {
  if (!captureMode) return;
  requestAnimationFrame(() => requestAnimationFrame(() => api.ready()));
});
localize();
