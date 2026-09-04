import { ipcMain, type IpcMainInvokeEvent } from 'electron'

/**
 * A thin wrapper over `ipcMain.handle`, so every main-process handler is
 * registered through one import rather than reaching for `ipcMain` directly.
 *
 * It used to keep a parallel Map of the same handlers, because the terminal
 * CLI reached them over a local socket and Electron gives no way to invoke a
 * registered handler from the main process (there is no `ipcMain.invoke`).
 * The CLI is gone, and with it the only caller that was not the renderer.
 */
export function handle(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => any
): void {
  ipcMain.handle(channel, listener)
}
