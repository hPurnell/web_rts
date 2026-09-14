/**
 * Editor entry point. Imported dynamically by the app shell so the editor is
 * code-split out of the game bundle.
 */
export { mountEditor, EDITOR_TOOLS } from './shell.ts';
export type { EditorContext, EditorHandle, EditorTool } from './shell.ts';
