/**
 * Editor entry point. Imported dynamically by the app shell so the editor is
 * code-split out of the game bundle.
 */
export { mountEditor, EDITOR_TOOLS } from './shell.ts';
export type { EditorContext, EditorHandle, EditorTool } from './shell.ts';
export { createSession } from './session.ts';
export type { EditorSession, SessionHooks } from './session.ts';
export { EditorHistory } from './history.ts';
export { TerrainEditCommand, ResourceNodeCommand, StartLocationCommand } from './commands.ts';
export {
  brushCells,
  brushCorners,
  describeSlope,
  rampTarget,
  stageFlagEdit,
  stageSculpt,
} from './sculpt.ts';
export type { SculptMode } from './sculpt.ts';
