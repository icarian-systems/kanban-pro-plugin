/**
 * Vitest mock for the `obsidian` module so unit tests can run outside the host.
 * Keep this minimal — anything beyond the surface used in tests should be added
 * deliberately, not by reflex.
 */

export class TFile {
  path: string = '';
  name: string = '';
  basename: string = '';
  extension: string = 'md';
  stat = { ctime: 0, mtime: 0, size: 0 };
  parent: TFolder | null = null;
}

export class TFolder {
  path: string = '';
  children: (TFile | TFolder)[] = [];
}

export class Notice {
  constructor(public message: string, _timeout?: number) {}
  hide() {}
  setMessage(m: string) { this.message = m; return this; }
}

export class Component {
  _children: Component[] = [];
  load() {}
  unload() {}
  onload() {}
  onunload() {}
  addChild<T extends Component>(c: T): T { this._children.push(c); return c; }
  removeChild<T extends Component>(c: T): T { return c; }
  register(_cb: () => unknown) {}
  registerEvent(_ref: unknown) {}
  registerDomEvent(_el: HTMLElement, _ev: string, _cb: EventListener) {}
  registerInterval(_id: number) {}
}

export class ItemView extends Component {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  leaf: WorkspaceLeaf;
  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.containerEl = document.createElement('div');
    this.contentEl = document.createElement('div');
    this.containerEl.appendChild(this.contentEl);
  }
  getViewType() { return ''; }
  getDisplayText() { return ''; }
  onOpen(): Promise<void> { return Promise.resolve(); }
  onClose(): Promise<void> { return Promise.resolve(); }
}

export class TextFileView extends ItemView {
  file: TFile | null = null;
  data: string = '';
  dirty: boolean = false;
  requestSave: () => void = () => { this.dirty = true; };
  getViewData(): string { return this.data; }
  setViewData(_data: string, _clear: boolean): void {}
  clear(): void {}
  save(_clear?: boolean): Promise<void> { return Promise.resolve(); }
  onLoadFile(_file: TFile): Promise<void> { return Promise.resolve(); }
  onUnloadFile(_file: TFile): Promise<void> { return Promise.resolve(); }
}

export class WorkspaceLeaf {
  view: ItemView | null = null;
  openFile(_file: TFile): Promise<void> { return Promise.resolve(); }
}

export class Workspace {
  getLeaf(): WorkspaceLeaf { return new WorkspaceLeaf(); }
  getActiveViewOfType<T>(_type: unknown): T | null { return null; }
  on(_name: string, _cb: (...a: unknown[]) => void): unknown { return {}; }
  off(_name: string, _cb: (...a: unknown[]) => void) {}
  offref(_ref: unknown) {}
  trigger(_name: string, ..._args: unknown[]) {}
  iterateAllLeaves(_cb: (leaf: WorkspaceLeaf) => void) {}
}

export class Vault {
  read(_f: TFile): Promise<string> { return Promise.resolve(''); }
  modify(_f: TFile, _data: string): Promise<void> { return Promise.resolve(); }
  cachedRead(_f: TFile): Promise<string> { return Promise.resolve(''); }
  on(_name: string, _cb: (...a: unknown[]) => void): unknown { return {}; }
  off(_name: string, _cb: (...a: unknown[]) => void) {}
  offref(_ref: unknown) {}
  getAbstractFileByPath(_p: string): TFile | TFolder | null { return null; }
}

export class MetadataCache {
  on(_name: string, _cb: (...a: unknown[]) => void): unknown { return {}; }
  off(_name: string, _cb: (...a: unknown[]) => void) {}
  offref(_ref: unknown) {}
  getFileCache(_f: TFile): { frontmatter?: Record<string, unknown> } | null { return null; }
}

export class App {
  workspace = new Workspace();
  vault = new Vault();
  metadataCache = new MetadataCache();
}

export class Plugin extends Component {
  app: App;
  manifest: { id: string; name: string; version: string };
  constructor(app: App, manifest: { id: string; name: string; version: string }) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  registerView(_type: string, _factory: (leaf: WorkspaceLeaf) => ItemView) {}
  registerMarkdownPostProcessor(_p: unknown) {}
  registerObsidianProtocolHandler(_action: string, _h: unknown) {}
  addCommand(_cmd: unknown) {}
  addRibbonIcon(_icon: string, _title: string, _cb: (e: MouseEvent) => unknown) {
    return document.createElement('div');
  }
  addStatusBarItem() { return document.createElement('div'); }
  addSettingTab(_t: unknown) {}
  loadData(): Promise<Record<string, unknown>> { return Promise.resolve({}); }
  saveData(_d: unknown): Promise<void> { return Promise.resolve(); }
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }
  display(): void {}
  hide(): void {}
}

// Test-only registry — every `Setting` constructed records its
// `addText` / `addButton` stubs here so tests can drive the captured
// callbacks (onClick / onChange) without rendering a real Obsidian
// modal. The production code only reads `setName`/`setDesc` for chrome
// and never inspects the registry, so this is invisible at runtime.
//
// Each entry is keyed by the row's `name` (set via `setName(...)`).
// Last-write wins when the same name is reused across panes; tests can
// clear the registry between cases with `__resetSettingRegistry()`.
export interface CapturedTextStub {
  value: string;
  placeholder?: string;
  onChange?: (v: string) => void;
  inputEl: HTMLInputElement;
}
export interface CapturedButtonStub {
  text: string;
  cta: boolean;
  warning: boolean;
  onClick?: () => void | Promise<void>;
}
export interface CapturedSetting {
  name: string;
  desc: string;
  text?: CapturedTextStub;
  buttons: CapturedButtonStub[];
}
const __settingRegistry: CapturedSetting[] = [];
export function __getSettingRegistry(): CapturedSetting[] {
  return __settingRegistry;
}
export function __resetSettingRegistry(): void {
  __settingRegistry.length = 0;
}
export function __findSettingByName(name: string): CapturedSetting | null {
  return __settingRegistry.find((r) => r.name === name) ?? null;
}

export class Setting {
  private record: CapturedSetting = { name: '', desc: '', buttons: [] };
  constructor(_el: HTMLElement) {
    __settingRegistry.push(this.record);
  }
  setName(n: string) { this.record.name = n; return this; }
  setDesc(d: string) { this.record.desc = d; return this; }
  addText(cb: (t: unknown) => unknown) {
    const inputEl = document.createElement('input');
    const stub: CapturedTextStub = { value: '', inputEl };
    const fluent = {
      setValue: (v: string) => { stub.value = v; inputEl.value = v; return fluent; },
      setPlaceholder: (p: string) => { stub.placeholder = p; inputEl.placeholder = p; return fluent; },
      onChange: (handler: (v: string) => void) => { stub.onChange = handler; return fluent; },
      inputEl,
    };
    this.record.text = stub;
    cb(fluent);
    return this;
  }
  addToggle(_cb: (t: unknown) => unknown) { return this; }
  addDropdown(_cb: (t: unknown) => unknown) { return this; }
  addButton(cb: (t: unknown) => unknown) {
    const stub: CapturedButtonStub = { text: '', cta: false, warning: false };
    const fluent = {
      setButtonText: (s: string) => { stub.text = s; return fluent; },
      setCta: () => { stub.cta = true; return fluent; },
      setWarning: () => { stub.warning = true; return fluent; },
      onClick: (handler: () => void | Promise<void>) => { stub.onClick = handler; return fluent; },
    };
    this.record.buttons.push(stub);
    cb(fluent);
    return this;
  }
}

export class MenuItem {
  private _title = '';
  private _icon = '';
  private _onClick: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  setTitle(t: string) { this._title = t; return this; }
  setIcon(i: string) { this._icon = i; return this; }
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => unknown) { this._onClick = cb; return this; }
  setDisabled(_d: boolean) { return this; }
}

export class Menu {
  private _items: MenuItem[] = [];
  addItem(cb: (item: MenuItem) => unknown) {
    const item = new MenuItem();
    cb(item);
    this._items.push(item);
    return this;
  }
  addSeparator() { return this; }
  showAtMouseEvent(_e: MouseEvent) { return this; }
  showAtPosition(_p: { x: number; y: number }) { return this; }
  hide() {}
}

export class Modal {
  app: App;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(app: App) {
    this.app = app;
    this.containerEl = document.createElement('div');
    this.contentEl = document.createElement('div');
  }
  open() {}
  close() {}
  onOpen() {}
  onClose() {}
}

export class MarkdownRenderer {
  static renderMarkdown(_md: string, _el: HTMLElement, _path: string, _component: Component): Promise<void> {
    return Promise.resolve();
  }
  static render(_app: App, _md: string, _el: HTMLElement, _path: string, _component: Component): Promise<void> {
    return Promise.resolve();
  }
}

export function requestUrl(_p: unknown): Promise<{ status: number; text: string; json: unknown; arrayBuffer: ArrayBuffer; headers: Record<string,string> }> {
  return Promise.resolve({ status: 200, text: '', json: {}, arrayBuffer: new ArrayBuffer(0), headers: {} });
}

export type RequestUrlParam = unknown;
export type RequestUrlResponse = {
  status: number;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
  headers: Record<string,string>;
};
export type ObsidianProtocolHandler = (params: Record<string, string>) => void;
export type ObsidianProtocolData = Record<string, string>;

export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false };

export interface MarkdownPostProcessorContext {
  docId: string;
  sourcePath: string;
  frontmatter: unknown;
  addChild: (c: Component) => void;
  getSectionInfo: (el: HTMLElement) => { lineStart: number; lineEnd: number; text: string } | null;
}

export const debounce = <T extends (...a: unknown[]) => unknown>(fn: T, ms: number) => {
  let id: ReturnType<typeof setTimeout> | undefined;
  const wrapped = ((...args: Parameters<T>) => {
    if (id) clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  }) as T & { cancel: () => void };
  (wrapped as unknown as { cancel: () => void }).cancel = () => { if (id) clearTimeout(id); };
  return wrapped;
};

export const moment = (d?: string | Date) => ({
  format: (_f: string) => '',
  toDate: () => new Date(d ?? Date.now()),
  isValid: () => true,
  valueOf: () => new Date(d ?? Date.now()).valueOf(),
});

export const setIcon = (_el: HTMLElement, _icon: string) => {};
export const addIcon = (_name: string, _svg: string) => {};
export const getIcon = (_name: string) => null;
