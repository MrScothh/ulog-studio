import * as Comlink from 'comlink';
import { Engine } from '../core/engine';

Comlink.expose(new Engine());
