import * as Comlink from 'comlink';
import type { Engine } from '../core/engine';
import EngineWorker from '../worker/engine.worker.ts?worker&inline';

let remote: Comlink.Remote<Engine> | undefined;

/** The analysis engine runs in a Web Worker so parsing and DSP never block the UI. */
export function engine(): Comlink.Remote<Engine> {
  if (!remote) remote = Comlink.wrap<Engine>(new EngineWorker());
  return remote;
}
