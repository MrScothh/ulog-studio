/** Platform abstraction: Tauri desktop shell vs. browser (PWA / single file). */
declare const __APP_VERSION__: string;
declare const __BUILD_TARGET__: 'desktop' | 'pwa' | 'single';

export const APP_VERSION = __APP_VERSION__;
export const BUILD_TARGET = __BUILD_TARGET__;
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export async function saveBytes(data: Uint8Array | string, name: string, mime: string): Promise<boolean> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (isTauri) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const ext = name.split('.').pop() ?? '*';
      const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (!path) return false;
      const { invoke: inv } = await import('@tauri-apps/api/core');
      await inv('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

export function saveCsv(text: string, name: string) { void saveBytes(text, name, 'text/csv'); }

export function saveCanvasPng(canvas: HTMLCanvasElement, name: string) {
  canvas.toBlob(async (b) => { if (b) await saveBytes(new Uint8Array(await b.arrayBuffer()), name, 'image/png'); }, 'image/png');
}

/** Files passed on the command line / via "Open with" (desktop only). */
export async function initialFiles(): Promise<{ name: string; data: ArrayBuffer }[]> {
  if (!isTauri) return [];
  const paths = await invoke<string[]>('initial_files');
  const out: { name: string; data: ArrayBuffer }[] = [];
  for (const p of paths) {
    const bytes = await readPath(p);
    if (bytes) out.push({ name: p.split(/[\\/]/).pop() ?? p, data: bytes });
  }
  return out;
}

export async function readPath(path: string): Promise<ArrayBuffer | undefined> {
  try {
    const r = await invoke<ArrayBuffer | number[]>('read_file', { path });
    return r instanceof ArrayBuffer ? r : new Uint8Array(r).buffer;
  } catch (e) {
    console.error(e);
    return undefined;
  }
}

// ---------------------------------------------------------------- updates (desktop)
export interface UpdateInfo { available: boolean; current: string; version?: string; notes?: string; date?: string; error?: string; repo?: string; tokenSource?: string }

export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isTauri) return { available: false, current: APP_VERSION, error: 'Updates are handled by the desktop app only.' };
  try { return await invoke<UpdateInfo>('check_update'); } catch (e) { return { available: false, current: APP_VERSION, error: String(e) }; }
}

export async function installUpdate(onProgress: (done: number, total?: number) => void): Promise<void> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<{ done: number; total?: number }>('update-progress', (e) => onProgress(e.payload.done, e.payload.total));
  try { await invoke('install_update'); } finally { un(); }
}

export async function getUpdateSettings(): Promise<{ repo: string; hasStoredToken: boolean; tokenSource?: string }> {
  return invoke('get_update_settings');
}
export async function setUpdateToken(token: string | null): Promise<void> { await invoke('set_update_token', { token }); }
